import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  createBootstrapCommand,
  createCommand,
  hostEventSchema,
  type BootstrapState,
  type AcademicCredentialSource,
  type AcademicCredentialStatus,
  type AutoMemoryReviewPolicy,
  type ContextUsage,
  type CitationSource,
  type ExecutionQueueItem,
  type HostCommand,
  type HostEvent,
  type LongTermMemoryDocument,
  type MemoryReviewProgress,
  type MemoryMaintenanceState,
  type MaterialInventoryItem,
  type MemoryCandidate,
  type ModelProfile,
  type Project,
  type ProjectContextDocument,
  type ProjectMemoryDocument,
  type ProjectOutputArtifact,
  type PromptContribution,
  type ProviderFailure,
  type ReviewBundle,
  type ReflectionRun,
  type SystemPromptRevision,
  type IntegrationState,
  type IntegrationTaskContext,
  type PiResourcesSettingsState,
  type SubAgentProjection,
  type SubAgentRunProjection,
  type SubAgentTaskDetailProjection,
  type TaskModelAssignment,
  type TaskModelType,
  type TrajectoryActivity,
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
  Languages,
  KeyRound,
  MessageSquare,
  Minimize2,
  Moon,
  PanelRight,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  SlidersHorizontal,
  Trash2
} from "lucide-react";
import remarkGfm from "remark-gfm";
import { useUiLanguage } from "./i18n";
import { PiResourcesSettings } from "./PiResourcesSettings";
import {
  applicationCommandSuggestions,
  applyComposerSuggestion,
  fileSuggestion,
  matchComposerSuggestions,
  profileSuggestion,
  thinkingSuggestion,
  type ComposerSuggestion
} from "./composer-suggestions";

const Markdown = lazy(() => import("react-markdown"));

type View = "workspace" | "settings";
const TASK_MODEL_TYPES: Array<{ id: TaskModelType; label: string; ariaLabel?: string }> = [
  { id: "ordinary_conversation", label: "Ordinary conversation" }, { id: "web_research", label: "Web research" },
  { id: "document_generation", label: "Document generation" },
  // Cognition is configured by product intent.
  { id: "reflection", label: "Reflection Profile", ariaLabel: "Reflection Profile" }, { id: "memory_review", label: "Memory Review Profile", ariaLabel: "Memory Review Profile" },
  { id: "visual_material_analysis", label: "Visual material analysis" },
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
      runtime?: TrajectoryActivity["runtime"];
      artifact?: { id: string; mediaType: string; destination: string };
    }
  | {
      id: string;
      turnId: string;
      role: "assistant";
      text: string;
      thinking: string;
      status: "queued" | "streaming" | "completed" | "failed" | "interrupted";
      profile?: TrajectoryProfile;
      usage?: TokenUsage;
      citations?: readonly CitationSource[];
      latencyMs?: number;
      recalledStateEstimatedTokens?: number;
      prompt?: {
        revisionId: string;
        contributions: PromptContribution;
        capabilitySurface?: {
          revision: string;
          visibleCapabilityIds: readonly string[];
          requestableCapabilityCount: number;
          initialToolSchemaEstimatedTokens: number;
          preloadHintCount: number;
        };
      };
      failure?: ProviderFailure;
      retryText?: string;
    };

type ConversationQuote = {
  id: string;
  threadId: string;
  turnId: string;
  role: "user" | "assistant";
  text: string;
};

type ConversationSelection = Omit<ConversationQuote, "id"> & {
  top: number;
  left: number;
};

const MAX_CONVERSATION_QUOTES = 5;
const MAX_CONVERSATION_QUOTE_LENGTH = 4_000;

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
  const [uiLanguage, toggleUiLanguage] = useUiLanguage();
  const [view, setView] = useState<View>("workspace");
  const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null);
  const [diagnostic, setDiagnostic] = useState<HostEvent | null>(null);
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [academicCredentials, setAcademicCredentials] = useState<AcademicCredentialStatus[]>([]);
  const [taskAssignments, setTaskAssignments] = useState<TaskModelAssignment[]>([]);
  const [integrationState, setIntegrationState] = useState<IntegrationState | null>(null);
  const [piResourcesState, setPiResourcesState] = useState<PiResourcesSettingsState | null>(null);
  const [subAgentProjections, setSubAgentProjections] = useState<Record<string, SubAgentProjection>>({});
  const [subAgentRunProjections, setSubAgentRunProjections] = useState<Record<string, SubAgentRunProjection>>({});
  const [subAgentTaskDetails, setSubAgentTaskDetails] = useState<Record<string, SubAgentTaskDetailProjection>>({});
  const [reflectionRuns, setReflectionRuns] = useState<ReflectionRun[]>([]);
  const [reflectionLaunch, setReflectionLaunch] = useState<(({ scope: "project"; projectId: string } | { scope: "unscoped"; threadId: string }) & { focus: string }) | null>(null);
  const [promptRevisions, setPromptRevisions] = useState<SystemPromptRevision[]>([]);
  const [activePromptRevisionId, setActivePromptRevisionId] = useState<string | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [executionQueue, setExecutionQueue] = useState<ExecutionQueueItem[]>([]);
  const [executionCapacity, setExecutionCapacity] = useState({ running: 0, capacity: 1 });
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Record<string, ConversationItem[]>>({});
  const [sessionContextByThread, setSessionContextByThread] = useState<Record<string, ContextUsage>>({});
  const [prompt, setPrompt] = useState("");
  const [composerCursor, setComposerCursor] = useState<number | null>(null);
  const [composerSuggestionIndex, setComposerSuggestionIndex] = useState(0);
  const [conversationQuotesByThread, setConversationQuotesByThread] = useState<Record<string, ConversationQuote[]>>({});
  const [conversationSelection, setConversationSelection] = useState<ConversationSelection | null>(null);
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
  const [outputsByProject, setOutputsByProject] = useState<Record<string, ProjectOutputArtifact[]>>({});
  const [recoveryExport, setRecoveryExport] = useState<string | null>(null);
  const [personalCognitionNotice, setPersonalCognitionNotice] = useState<string | null>(null);
  const [longTermMemoryDocument, setLongTermMemoryDocument] = useState<LongTermMemoryDocument | null>(null);
  const [longTermMemoryDraft, setLongTermMemoryDraft] = useState("");
  const [memoryMaintenance, setMemoryMaintenance] = useState<MemoryMaintenanceState | null>(null);
  const [activeReviewBundle, setActiveReviewBundle] = useState<ReviewBundle | null>(null);
  const [memoryReviewProgress, setMemoryReviewProgress] = useState<MemoryReviewProgress | null>(null);
  const [memoryReviewPolicy, setMemoryReviewPolicy] = useState<AutoMemoryReviewPolicy | null>(null);
  const [cognitionCommitNotice, setCognitionCommitNotice] = useState<string | null>(null);
  const [deleteThreadId, setDeleteThreadId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState<{ threadId: string; title: string } | null>(null);
  const longTermMemoryDirty = useRef(false);
  const activeThreadIdRef = useRef<string | null>(null);
  const pendingProfileSelections = useRef<Record<string, Promise<unknown>>>({});
  const composerInput = useRef<HTMLTextAreaElement | null>(null);

  activeThreadIdRef.current = activeThreadId;

  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  const activeSessionContext = activeThreadId === null ? undefined : sessionContextByThread[activeThreadId];
  const activeProfile = profiles.find((profile) => profile.id === activeThread?.activeProfileId);
  const activeProject = activeThread?.scope === "project" ? projects.find((project) => project.id === activeThread.projectId) : undefined;
  const activeReflection = reflectionRuns.find((run) => run.threadId === activeThreadId);
  const activeReflectionProfile = profiles.find((profile) => profile.id === activeReflection?.independentProfileId);
  const items = activeThreadId === null ? [] : conversations[activeThreadId] ?? [];
  const activeConversationQuotes = activeThreadId === null ? [] : conversationQuotesByThread[activeThreadId] ?? [];
  const latestTurnId = items.at(-1)?.turnId;
  const integrationContext = resolveIntegrationTaskContext({ activeThread, activeProject, activeProfile, latestTurnId, accessMode: bootstrap?.accessMode ?? "standard" });
  const hasActiveTurn = items.some(
    (item) => item.role === "assistant" && (item.status === "queued" || item.status === "streaming")
  );
  const activeTurn = items.find((item) => item.role === "assistant" && (item.status === "queued" || item.status === "streaming"));
  const readOnlyRecovery = bootstrap?.storageMode === "read_only_recovery";
  const composerCandidates: ComposerSuggestion[] = [
    ...applicationCommandSuggestions(),
    ...profiles.map((profile) => profileSuggestion(profile)),
    ...(["off", "minimal", "low", "medium", "high", "xhigh"] as const).map(thinkingSuggestion),
    ...(activeThread?.scope === "project" ? (materialsByProject[activeThread.projectId] ?? [])
      .filter((item) => item.availability === "active")
      .map((item) => fileSuggestion(item.relativePath)) : [])
  ];
  const composerSuggestionMatch = composerCursor === null
    ? null
    : matchComposerSuggestions(prompt, composerCursor, composerCandidates);
  const learningTelemetry = {
    coveredScopes: memoryReviewProgress?.processed ?? 0,
    totalScopes: memoryReviewProgress?.eligible ?? 0,
    failureCount: reflectionRuns.filter((run) => run.status.includes("failed")).length
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
      case "long_term_memory.maintenance.loaded":
      case "long_term_memory.maintenance.updated": setMemoryMaintenance(event.payload.state); break;
      case "long_term_memory.provenance.inspected": break;
      case "access.mode.changed": setBootstrap((current) => current === null ? current : { ...current, accessMode: event.payload.mode }); break;
      case "profiles.listed": setProfiles(event.payload.profiles); break;
      case "academic.credentials.updated": setAcademicCredentials(event.payload.credentials); break;
      case "integration.state.updated": setIntegrationState(event.payload.state); break;
      case "pi.resources.updated": setPiResourcesState(event.payload.state); break;
      case "integration.job.updated": setIntegrationState((current) => current === null ? current : { ...current, runtime: { ...current.runtime, runningJobs: event.payload.job.state === "running" ? current.runtime.runningJobs + 1 : current.runtime.runningJobs, queuedJobs: event.payload.job.state === "queued" ? current.runtime.queuedJobs + 1 : current.runtime.queuedJobs }, ...(event.payload.workflow === "office" ? { office: { ...current.office, jobs: [...current.office.jobs.filter((job) => job.id !== event.payload.job.id), event.payload.job] } } : {}), ...(event.payload.workflow === "page_recovery" ? { pageRecovery: { ...current.pageRecovery, parses: [...current.pageRecovery.parses.filter((job) => job.id !== event.payload.job.id), event.payload.job] } } : {}) }); break;
      case "integration.diagnostic": setDiagnostic(localDiagnostic(`${event.payload.workflow}: ${event.payload.code} · ${event.payload.message}`)); break;
      case "sub_agent.runs.listed":
        setSubAgentRunProjections(Object.fromEntries(event.payload.projections.map((projection) => [projection.run.id, projection])));
        break;
      case "sub_agent.task.inspected":
        setSubAgentTaskDetails((current) => ({ ...current, [event.payload.projection.task.id]: event.payload.projection }));
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
      case "profile.updated":
      case "profile.credential.updated": setProfiles((current) => [...current.filter((item) => item.id !== event.payload.profile.id), event.payload.profile]); break;
      case "task_model_assignments.listed": setTaskAssignments(event.payload.assignments); break;
      case "task_model_assignment.updated": setTaskAssignments((current) => event.payload.assignment === undefined ? current.filter((item) => item.taskType !== event.payload.taskType) : [...current.filter((item) => item.taskType !== event.payload.taskType), event.payload.assignment]); break;
      case "cognition_review.bundle.updated": setActiveReviewBundle(event.payload.bundle); break;
      case "cognition_review.bundles.listed": {
        const candidate = event.payload.bundles.find((bundle) => ["analysis_completed", "waiting_for_review", "reviewing", "prepared", "stale"].includes(bundle.status));
        setActiveReviewBundle(candidate ?? event.payload.bundles.at(-1) ?? null);
        break;
      }
      case "memory_review.progress.updated": setMemoryReviewProgress(event.payload.progress); break;
      case "memory_review.policy.updated": setMemoryReviewPolicy(event.payload.policy); break;
      case "cognition_review.commit.result": {
        const result = event.payload.result;
        setCognitionCommitNotice(result.status === "committed" ? "Cognition committed." : result.status === "stale" ? "Review became stale; prepare it again." : `Cognition commit failed${result.errorCode === undefined ? "" : ` · ${result.errorCode}`}.`);
        setActiveReviewBundle((bundle) => bundle === null || bundle.id !== result.reviewId ? bundle : { ...bundle, status: result.status === "committed" ? "committed" : result.status === "stale" ? "stale" : bundle.status, updatedAt: new Date().toISOString() });
        break;
      }
      case "reflection.run.created":
        setReflectionRuns((current) => [event.payload.run, ...current.filter((item) => item.id !== event.payload.run.id)]);
        setThreads((current) => [...current.filter((item) => item.id !== event.payload.thread.id), event.payload.thread]);
        setActiveThreadId(event.payload.thread.id);
        setReflectionLaunch(null);
        setView("workspace");
        break;
      case "reflection.run.updated": setReflectionRuns((current) => [event.payload.run, ...current.filter((item) => item.id !== event.payload.run.id)]); break;
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
        break;
      }
      case "memory.candidate.captured": setMemoryCandidates((current) => ({ ...current, [event.payload.candidate.id]: event.payload.candidate })); break;
      case "memory.candidate.resolved":
        setMemoryCandidates((current) => ({ ...current, [event.payload.candidate.id]: event.payload.candidate }));
        break;
      case "thread.trajectory.deleted":
        setConversations((current) => ({ ...current, [event.payload.threadId]: [] }));
        setSessionContextByThread((current) => Object.fromEntries(Object.entries(current).filter(([threadId]) => threadId !== event.payload.threadId)));
        setConversationQuotesByThread((current) => Object.fromEntries(Object.entries(current).filter(([threadId]) => threadId !== event.payload.threadId)));
        setMemoryCandidates((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !event.payload.removedCandidateIds.includes(id))));
        break;
      case "thread.archived":
        setThreads((current) => [...current.filter((item) => item.id !== event.payload.thread.id), event.payload.thread]);
        break;
      case "thread.deleted":
        setThreads((current) => current.filter((item) => item.id !== event.payload.threadId));
        setConversations((current) => Object.fromEntries(Object.entries(current).filter(([threadId]) => threadId !== event.payload.threadId)));
        setSessionContextByThread((current) => Object.fromEntries(Object.entries(current).filter(([threadId]) => threadId !== event.payload.threadId)));
        setConversationQuotesByThread((current) => Object.fromEntries(Object.entries(current).filter(([threadId]) => threadId !== event.payload.threadId)));
        setMemoryCandidates((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !event.payload.removedCandidateIds.includes(id))));
        setActiveThreadId((current) => current === event.payload.threadId ? null : current);
        setDeleteThreadId(null);
        setRenameDraft((current) => current?.threadId === event.payload.threadId ? null : current);
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
        {
          const contextUsage = [...event.payload.turns].reverse().find((turn) => turn.contextUsage !== undefined)?.contextUsage;
          if (contextUsage !== undefined) setSessionContextByThread((current) => ({ ...current, [event.payload.threadId]: contextUsage }));
        }
        break;
      case "thread.created":
        setThreads((current) => [...current, event.payload.thread]);
        activeThreadIdRef.current = event.payload.thread.id;
        setActiveThreadId(event.payload.thread.id);
        setView("workspace");
        break;
      case "thread.renamed":
        setThreads((current) => current.map((item) => item.id === event.payload.thread.id ? event.payload.thread : item));
        setRenameDraft((current) => current?.threadId === event.payload.thread.id ? null : current);
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
        setConversationQuotesByThread((current) => ({ ...current, [event.payload.item.threadId]: [] }));
        setPrompt("");
        break;
      case "execution_queue.updated":
        setExecutionQueue(event.payload.items);
        setExecutionCapacity({ running: event.payload.runningCount, capacity: event.payload.capacity });
        setBootstrap((current) => current === null ? current : { ...current, executionScheduler: event.payload.telemetry });
        break;
      case "turn.accepted":
        setConversations((current) => appendTurn(current, event.payload.threadId, event.payload.turnId, event.payload.text, event.payload.profile, event.payload.prompt));
        setConversationQuotesByThread((current) => ({ ...current, [event.payload.threadId]: [] }));
        setPrompt("");
        break;
      case "turn.started":
        setConversations((current) => updateAssistant(current, event.payload.threadId, event.payload.turnId, (item) => ({ ...item, status: "streaming" })));
        break;
      case "message.delta":
        setConversations((current) => updateAssistant(current, event.payload.threadId, event.payload.turnId, (item) => ({ ...item, text: item.text + event.payload.delta, status: "streaming" })));
        break;
      case "thinking.delta":
        setConversations((current) => updateAssistant(current, event.payload.threadId, event.payload.turnId, (item) => ({ ...item, thinking: item.thinking + event.payload.delta, status: "streaming" })));
        break;
      case "session.context.updated":
        setSessionContextByThread((current) => ({ ...current, [event.payload.threadId]: event.payload.contextUsage }));
        break;
      case "turn.completed":
        setConversations((current) => updateAssistant(current, event.payload.threadId, event.payload.turnId, (item) => ({ ...item, text: event.payload.message, status: "completed", profile: event.payload.profile, usage: event.payload.usage, ...(event.payload.citations === undefined ? {} : { citations: event.payload.citations }), latencyMs: event.payload.latencyMs, recalledStateEstimatedTokens: event.payload.recalledStateEstimatedTokens })));
        if (event.payload.contextUsage !== undefined) setSessionContextByThread((current) => ({ ...current, [event.payload.threadId]: event.payload.contextUsage! }));
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
    void invoke(createCommand({ command: "academic.credentials.list" }));
    void invoke(createCommand({ command: "pi.resources.load" }));
    void invoke(createCommand({ command: "integration.state.load" }));
    void invoke(createCommand({ command: "task_model_assignment.list" }));
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
    const clearCollapsedSelection = () => {
      if (window.getSelection()?.isCollapsed !== false) setConversationSelection(null);
    };
    const clearOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConversationSelection(null);
    };
    document.addEventListener("selectionchange", clearCollapsedSelection);
    window.addEventListener("keydown", clearOnEscape);
    window.addEventListener("resize", clearCollapsedSelection);
    return () => {
      document.removeEventListener("selectionchange", clearCollapsedSelection);
      window.removeEventListener("keydown", clearOnEscape);
      window.removeEventListener("resize", clearCollapsedSelection);
    };
  }, []);

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
    setConversationSelection(null);
    setProjectPanelTab("overview");
    setView("workspace");
    void invoke(createCommand({ command: "thread.trajectory.load", payload: { threadId } }));
  };

  const captureConversationSelection = () => {
    const threadId = activeThreadIdRef.current;
    if (threadId === null || readOnlyRecovery || hasActiveTurn) {
      setConversationSelection(null);
      return;
    }
    window.requestAnimationFrame(() => setConversationSelection(readConversationSelection(threadId)));
  };

  const addConversationSelection = () => {
    const selection = conversationSelection;
    if (selection === null) return;
    setConversationQuotesByThread((current) => {
      const quotes = current[selection.threadId] ?? [];
      const duplicate = quotes.some((quote) => quote.turnId === selection.turnId && quote.role === selection.role && quote.text === selection.text);
      if (quotes.length >= MAX_CONVERSATION_QUOTES || duplicate) return current;
      return {
        ...current,
        [selection.threadId]: [...quotes, {
          id: crypto.randomUUID(),
          threadId: selection.threadId,
          turnId: selection.turnId,
          role: selection.role,
          text: selection.text
        }]
      };
    });
    setConversationSelection(null);
    window.getSelection()?.removeAllRanges();
    window.requestAnimationFrame(() => composerInput.current?.focus());
  };

  const removeConversationQuote = (quoteId: string) => {
    const threadId = activeThreadIdRef.current;
    if (threadId === null) return;
    setConversationQuotesByThread((current) => ({
      ...current,
      [threadId]: (current[threadId] ?? []).filter((quote) => quote.id !== quoteId)
    }));
  };

  const executeComposerCommand = async (text: string): Promise<boolean> => {
    const command = text.trim();
    if (!command.startsWith("/")) return false;
    const finish = () => {
      setPrompt("");
      setComposerCursor(null);
      setComposerSuggestionIndex(0);
    };
    if (command === "/compact") {
      finish();
      if (activeThreadId === null || activeProfile === undefined || items.length === 0 || activeReflection !== undefined || hasActiveTurn) {
        setDiagnostic(localDiagnostic("Compact requires an idle ordinary conversation with an active Model Profile and at least one completed Turn."));
      } else {
        await invoke(createCommand({ command: "thread.compact", payload: { threadId: activeThreadId } }));
      }
      return true;
    }
    if (command === "/memory-review") {
      finish();
      if (hasActiveTurn) {
        setDiagnostic(localDiagnostic("Memory Review cannot be prepared while this task has an active Turn."));
      } else {
        void invoke(createCommand({ command: "memory_review.prepare", payload: {} }));
      }
      return true;
    }
    if (command === "/reflection") {
      finish();
      if (activeThread === undefined || activeReflection !== undefined || hasActiveTurn) {
        setDiagnostic(localDiagnostic("Reflection requires an idle task that is not already a Reflection."));
      } else {
        setReflectionLaunch(activeThread.scope === "project"
          ? { scope: "project", projectId: activeThread.projectId, focus: "" }
          : { scope: "unscoped", threadId: activeThread.id, focus: "" });
      }
      return true;
    }
    const modelMatch = command.match(/^\/model(?:\s+(.+))?$/u);
    if (modelMatch !== null) {
      const query = modelMatch[1]?.trim();
      if (query === undefined || query === "") {
        setDiagnostic(localDiagnostic("Choose a Model Profile after /model."));
      } else if (hasActiveTurn) {
        setDiagnostic(localDiagnostic("The Model Profile cannot be changed during an active Turn."));
      } else {
        const normalized = query.toLocaleLowerCase();
        const profile = profiles.find((item) =>
          item.id.toLocaleLowerCase() === normalized
          || item.name.toLocaleLowerCase() === normalized
          || item.model.toLocaleLowerCase() === normalized
          || `${item.provider}/${item.model}`.toLocaleLowerCase() === normalized
        );
        if (profile === undefined) setDiagnostic(localDiagnostic(`Unknown Model Profile: ${query}`));
        else selectProfile(profile.id);
      }
      finish();
      return true;
    }
    const thinkingMatch = command.match(/^\/thinking(?:\s+(\S+))?$/u);
    if (thinkingMatch !== null) {
      const level = thinkingMatch[1] as ModelProfile["thinkingLevel"] | undefined;
      const supported = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
      if (activeProfile === undefined) {
        setDiagnostic(localDiagnostic("Select an active Model Profile before changing reasoning."));
      } else if (hasActiveTurn) {
        setDiagnostic(localDiagnostic("Reasoning cannot be changed during an active Turn."));
      } else if (level === undefined || !supported.includes(level)) {
        setDiagnostic(localDiagnostic(`Choose a reasoning level: ${supported.join(", ")}.`));
      } else {
        await invoke(createCommand({
          command: "profile.update",
          payload: {
            profileId: activeProfile.id,
            name: activeProfile.name,
            provider: activeProfile.provider,
            model: activeProfile.model,
            thinkingLevel: level,
            ...(activeProfile.contextWindow === undefined ? {} : { contextWindow: activeProfile.contextWindow }),
            ...(activeProfile.maxOutputTokens === undefined ? {} : { maxOutputTokens: activeProfile.maxOutputTokens })
          }
        }));
      }
      finish();
      return true;
    }
    return false;
  };

  const submit = async (text = prompt, retryOfTurnId?: string) => {
    const threadId = activeThreadIdRef.current;
    if (threadId === null || text.trim().length === 0) return;
    if (retryOfTurnId === undefined && await executeComposerCommand(text)) return;
    const includeConversationQuotes = retryOfTurnId === undefined && text === prompt;
    const submissionText = includeConversationQuotes
      ? serializeConversationQuotes(text.trim(), conversationQuotesByThread[threadId] ?? [])
      : text.trim();
    if (submissionText.length > 200_000) {
      setDiagnostic(localDiagnostic("Message and Conversation Quotes exceed the 200,000 character Turn limit."));
      return;
    }
    await pendingProfileSelections.current[threadId];
    await invoke(createCommand({
      command: "turn.submit",
      payload: { threadId, text: submissionText, ...(retryOfTurnId === undefined ? {} : { retryOfTurnId }) }
    }));
  };

  const chooseComposerSuggestion = (suggestion: ComposerSuggestion) => {
    if (composerSuggestionMatch === null) return;
    const next = applyComposerSuggestion(prompt, composerSuggestionMatch, suggestion);
    setPrompt(next.text);
    const opensArguments = suggestion.kind === "command" && (suggestion.value === "/model" || suggestion.value === "/thinking");
    setComposerCursor(opensArguments ? next.cursor : null);
    setComposerSuggestionIndex(0);
    if (suggestion.kind === "profile" || suggestion.kind === "thinking") {
      void submit(next.text.trim());
      return;
    }
    window.requestAnimationFrame(() => {
      composerInput.current?.focus();
      composerInput.current?.setSelectionRange(next.cursor, next.cursor);
    });
  };

  const stop = () => {
    if (activeThreadId === null || activeTurn?.role !== "assistant") return;
    void invoke(createCommand({ command: "turn.stop", payload: { threadId: activeThreadId, turnId: activeTurn.turnId } }));
  };

  const openRenameThread = (thread: Thread) => {
    if (readOnlyRecovery) return;
    setRenameDraft({ threadId: thread.id, title: thread.title });
  };

  const submitRenameThread = async () => {
    if (renameDraft === null) return;
    const title = renameDraft.title.trim();
    if (title.length === 0) return;
    const event = await invoke(createCommand({ command: "thread.rename", payload: { threadId: renameDraft.threadId, title } }));
    if (event?.event === "thread.renamed") setRenameDraft(null);
  };

  const compact = () => {
    if (activeThreadId === null || hasActiveTurn) return;
    void invoke(createCommand({ command: "thread.compact", payload: { threadId: activeThreadId } }));
  };

  const openMemoryReview = () => {
    if (readOnlyRecovery || hasActiveTurn) {
      setDiagnostic(localDiagnostic("Memory Review requires an idle task."));
      return;
    }
    void invoke(createCommand({ command: "memory_review.prepare", payload: {} }));
  };

  const deleteThread = async () => {
    if (deleteThreadId === null) return;
    const event = await invoke(createCommand({ command: "thread.delete", payload: { threadId: deleteThreadId, confirmed: true } }));
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

  const openReflectionLaunch = (projectId: string) => {
    setReflectionLaunch({ scope: "project", projectId, focus: "" });
  };

  const openUnscopedReflectionLaunch = (threadId: string) => {
    setReflectionLaunch({ scope: "unscoped", threadId, focus: "" });
  };

  const launchReflection = async () => {
    if (reflectionLaunch === null) return;
    const common = reflectionLaunch.focus.trim() === "" ? {} : { focus: reflectionLaunch.focus.trim() };
    await invoke(createCommand({ command: "reflection.start", payload: reflectionLaunch.scope === "project"
      ? { scope: "project", projectId: reflectionLaunch.projectId, ...common }
      : { scope: "unscoped", threadId: reflectionLaunch.threadId, ...common } }));
    setReflectionLaunch(null);
  };

  const finishReflection = (runId: string) => {
    void invoke(createCommand({ command: "reflection.finish", payload: { runId } }));
  };

  const decideReviewProposal = (bundle: ReviewBundle, proposalId: string, decision: "adopt" | "defer" | "reject") => {
    const decisions = [
      ...bundle.decisions.filter((item) => item.proposalId !== proposalId).map(({ proposalId: id, decision: value }) => ({ proposalId: id, decision: value })),
      { proposalId, decision }
    ];
    void invoke(createCommand({ command: "cognition_review.decide", payload: { reviewId: bundle.id, decisions } }));
  };

  const commitReview = (reviewId: string) => {
    void invoke(createCommand({ command: "cognition_review.commit", payload: { reviewId } }));
  };

  const discardReview = (reviewId: string) => {
    void invoke(createCommand({ command: "cognition_review.discard", payload: { reviewId } }));
  };

  return (
    <div className={`app-shell ${readOnlyRecovery ? "read-only-recovery" : ""}`}>
      <aside className="left-rail" aria-label="Navigation">
        <div className="brand-row">
          <div className="brand-mark">VC</div><span>vc-agent</span>
          <div className="brand-actions">
            <button className="language-button" type="button" title="Language" aria-label="Language" onClick={toggleUiLanguage}><Languages size={16} /><span>{uiLanguage === "en" ? "中" : "EN"}</span></button>
            <button className="icon-button" type="button" title="Search" aria-label="Search" disabled><Search size={17} /></button>
          </div>
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
        {memoryReviewProgress !== null && <MemoryReviewProgressPanel progress={memoryReviewProgress} onCancel={() => void invoke(createCommand({ command: "memory_review.cancel", payload: {} }))} />}
        {cognitionCommitNotice !== null && <div className="cognition-review-notice" role="status">{cognitionCommitNotice}</div>}
        {activeReviewBundle !== null && <CognitionReviewPanel bundle={activeReviewBundle} onDecision={decideReviewProposal} onCommit={commitReview} onDiscard={discardReview} />}
        {view === "settings" ? (
          <SettingsView bootstrap={bootstrap} profiles={profiles} academicCredentials={academicCredentials} taskAssignments={taskAssignments} projects={projects} materialsByProject={materialsByProject} integrationState={integrationState} piResourcesState={piResourcesState} subAgentProjections={subAgentProjections} subAgentRunProjections={subAgentRunProjections} subAgentTaskDetails={subAgentTaskDetails} activeThreadId={activeThreadId} activeThread={activeThread} activeProfile={activeProfile} integrationContext={integrationContext} promptRevisions={promptRevisions} activePromptRevisionId={activePromptRevisionId} formOpen={profileFormOpen} setFormOpen={setProfileFormOpen} invoke={invoke} readOnly={readOnlyRecovery} recoveryExport={recoveryExport} personalCognitionNotice={personalCognitionNotice} learningTelemetry={learningTelemetry} longTermMemoryDocument={longTermMemoryDocument} longTermMemoryDraft={longTermMemoryDraft} memoryMaintenance={memoryMaintenance} memoryReviewProgress={memoryReviewProgress} memoryReviewPolicy={memoryReviewPolicy} openMemoryReview={openMemoryReview} onLongTermMemoryChange={(content) => { longTermMemoryDirty.current = true; setLongTermMemoryDraft(content); }} onLongTermMemoryRefresh={() => { longTermMemoryDirty.current = false; void invoke(createCommand({ command: "long_term_memory.refresh" })); }} />
        ) : activeThread === undefined ? (
          <div className="empty-workspace" data-testid="empty-workspace"><div className="empty-icon"><MessageSquare size={22} /></div><h1>No active thread</h1><p>Create or select a thread from the navigation.</p></div>
        ) : (
          <section className="conversation" aria-label="Conversation">
             <header className="conversation-header"><div><span className="eyebrow">{activeThread.scope === "project" ? projects.find((project) => project.id === activeThread.projectId)?.displayName ?? "Project Thread" : "Unscoped Thread"}</span><h1>{activeThread.title}</h1></div><div className="conversation-header-actions"><ContextUsageIndicator usage={activeSessionContext} /><span className="header-model">{activeReflection === undefined ? activeProfile === undefined ? "No profile" : `${activeProfile.provider} / ${activeProfile.model}` : activeReflectionProfile === undefined ? reflectionStatusLabel(activeReflection.status) : `${activeReflectionProfile.provider} / ${activeReflectionProfile.model}`}</span><button className="icon-button" type="button" title="Rename thread" aria-label="Rename thread" onClick={() => openRenameThread(activeThread)} disabled={readOnlyRecovery}><Pencil size={15} /></button><button className="icon-button" type="button" title={activeThread.archivedAt === undefined ? "Archive thread" : "Restore thread"} aria-label={activeThread.archivedAt === undefined ? "Archive thread" : "Restore thread"} onClick={() => void invoke(createCommand({ command: "thread.archive.set", payload: { threadId: activeThread.id, archived: activeThread.archivedAt === undefined } }))} disabled={hasActiveTurn || readOnlyRecovery}><Archive size={15} /></button><button className="icon-button" type="button" title="Delete thread" aria-label="Delete thread" onClick={() => setDeleteThreadId(activeThread.id)} disabled={hasActiveTurn || readOnlyRecovery}><Trash2 size={15} /></button></div></header>
            <div className="message-list" onPointerUp={captureConversationSelection} onScroll={() => setConversationSelection(null)}>
              {activeReflection !== undefined && <ReflectionWorkspace run={activeReflection} finish={() => finishReflection(activeReflection.id)} discard={() => void invoke(createCommand({ command: "reflection.discard", payload: { runId: activeReflection.id } }))} />}
              {items.length === 0 ? activeReflection === undefined && <div className="thread-empty"><MessageSquare size={20} /><span>Ready for a new conversation</span></div> : groupConversationItems(items).map((turn) => (
                <ConversationTurn key={turn.turnId} items={turn.items} configure={() => setView("settings")} chooseOutput={chooseOutputLocation} retry={(text, turnId) => submit(text, turnId)} continueInterrupted={() => setPrompt("Continue from the interrupted response.")} />
              ))}
              {Object.values(memoryCandidates).filter((candidate) => candidate.threadId === activeThreadId && candidate.status === "active").map((candidate) => <div className="memory-candidate" key={candidate.id}><div><strong>Memory candidate captured</strong><span>{candidate.sourceSnippet}</span></div><div><button type="button" onClick={() => void invoke(createCommand({ command: "memory.candidate.dismiss", payload: { candidateId: candidate.id } }))}>Dismiss</button></div></div>)}
              {Object.values(confirmations).filter((item) => item.payload.threadId === activeThreadId).map((item) => <div className="action-proposal" role="dialog" aria-label="Capability confirmation" key={item.payload.requestId}>
                <strong>{item.payload.action}</strong><span className={`decision-class ${item.payload.decisionClass}`}>{item.payload.decisionClass} decision</span><p>{item.payload.target}</p><span>{item.payload.reason} {item.payload.expectedEffect}</span>{item.payload.preview !== undefined && <details><summary>Review diff</summary><pre>{item.payload.preview}</pre></details>}<div><button type="button" onClick={() => resolveConfirmation(item.payload.requestId, true)}>Approve</button><button type="button" onClick={() => resolveConfirmation(item.payload.requestId, false)}>Deny</button></div>
              </div>)}
              {profileChange && <div className="profile-change" role="dialog" aria-label="Cross-Provider continuation">
                <strong>Change Provider for this conversation?</strong>
                <p>{profileChange.payload.currentProfile.provider} / {profileChange.payload.currentProfile.model} to {profileChange.payload.requestedProfile.provider} / {profileChange.payload.requestedProfile.model}</p>
                <span>Continuing retains the visible Thread trajectory. Starting a new Thread retains no conversation context.</span>
                <div><button type="button" onClick={() => resolveProfileChange("continue_current_thread")}>Continue current thread</button><button type="button" onClick={() => resolveProfileChange("start_new_thread")}>Start new thread</button><button type="button" onClick={() => setProfileChange(null)}>Cancel</button></div>
              </div>}
            </div>
            {conversationSelection?.threadId === activeThread.id && <button
              className="add-selection-to-task"
              type="button"
              style={{ top: conversationSelection.top, left: conversationSelection.left }}
              onPointerDown={(event) => event.preventDefault()}
              onClick={addConversationSelection}
              disabled={activeConversationQuotes.length >= MAX_CONVERSATION_QUOTES}
              title={activeConversationQuotes.length >= MAX_CONVERSATION_QUOTES ? "Conversation Quote limit reached" : "Add selected text as a Conversation Quote"}
            >{activeConversationQuotes.length >= MAX_CONVERSATION_QUOTES ? "5 quote limit reached" : "Add to task"}</button>}
          </section>
        )}

        {view === "workspace" && projectCollision && <div className="workspace-dialog" role="dialog" aria-label="Project identity collision">
          <strong>Project Identity Collision</strong><p>{projectCollision.payload.selectedPath}</p><span>This identity is already registered at {projectCollision.payload.existingPath}. Classify the folder explicitly.</span><div><button type="button" onClick={() => resolveProjectCollision("moved_project")}>Moved Project</button><button type="button" onClick={() => resolveProjectCollision("project_copy")}>Project Copy</button><button type="button" onClick={() => setProjectCollision(null)}>Cancel</button></div>
        </div>}
        {view === "workspace" && parseRefreshChoice && <div className="workspace-dialog" role="dialog" aria-label="Parse refresh choice">
          <strong>Material changed</strong><p>{parseRefreshChoice.payload.material.relativePath}</p><span>Previous {parseRefreshChoice.payload.previousSourceHash.slice(0, 12)} · Current {parseRefreshChoice.payload.currentSourceHash.slice(0, 12)} · {parseRefreshChoice.payload.parserId}</span><div><button className="primary-button" type="button" onClick={() => resolveParseRefresh("create_new_version")}>Create New Parse Version</button><button type="button" onClick={() => resolveParseRefresh("replace_previous")}>Replace Previous Parse</button><button type="button" onClick={() => resolveParseRefresh("cancel")}>Cancel</button></div>
        </div>}
        {view === "workspace" && reflectionLaunch && <div className="workspace-dialog reflection-launch" role="dialog" aria-label="Start Investment Reflection"><strong>Start Investment Reflection</strong><span>{reflectionLaunch.scope === "project" ? "The first pass is isolated from Project Memory and Long-term Memory." : "The first pass uses only frozen User inputs and public evidence. It cannot access Project State or Memory."}</span><label>Optional focus<textarea aria-label="Reflection focus" value={reflectionLaunch.focus} onChange={(event) => setReflectionLaunch({ ...reflectionLaunch, focus: event.target.value })} placeholder={reflectionLaunch.scope === "project" ? "Review this Project broadly" : "Review this investment question broadly"} /></label><div className="form-actions"><button type="button" onClick={() => setReflectionLaunch(null)}>Cancel</button><button className="primary-button" type="button" onClick={() => void launchReflection()}>Start Reflection</button></div></div>}
        {renameDraft !== null && <form className="workspace-dialog rename-thread-dialog" role="dialog" aria-label="Rename thread" onSubmit={(event) => { event.preventDefault(); void submitRenameThread(); }}><strong>Rename thread</strong><label>Thread name<input aria-label="Thread name" value={renameDraft.title} maxLength={120} autoFocus onChange={(event) => setRenameDraft({ ...renameDraft, title: event.target.value })} /></label><span>Use 1–120 characters.</span><div className="form-actions"><button type="button" onClick={() => setRenameDraft(null)}>Cancel</button><button className="primary-button" type="submit" disabled={renameDraft.title.trim().length === 0}>Save name</button></div></form>}
        {deleteThreadId !== null && <div className="workspace-dialog" role="dialog" aria-label="Delete thread"><strong>Delete this thread?</strong><span>This removes the Thread from the project, together with its retained conversation, physical context, queued work, unapproved candidates, and cognition-review source text. Confirmed Memory and Outputs remain.</span><div className="form-actions"><button type="button" onClick={() => setDeleteThreadId(null)}>Cancel</button><button className="danger-button" type="button" onClick={() => void deleteThread()}>Delete thread</button></div></div>}

        {view === "workspace" && activeThread !== undefined && (activeReflection === undefined || activeReflection.status === "dialogue_active") && (
          <form className="composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            {executionQueue.filter((item) => item.threadId === activeThread.id).length > 0 && <div className="execution-queue" aria-label="Execution Queue">
              <div className="execution-queue-heading"><strong>Execution Queue</strong><span>{executionCapacity.running} / {executionCapacity.capacity} running</span></div>
              {executionQueue.filter((item) => item.threadId === activeThread.id).map((item, index, items) => <div className="execution-queue-item" key={item.id}>
                <textarea aria-label={`Queued message ${index + 1}`} value={item.text} onChange={(event) => setExecutionQueue((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, text: event.target.value } : candidate))} onBlur={() => item.text.trim() && void invoke(createCommand({ command: "execution_queue.update", payload: { itemId: item.id, text: item.text.trim() } }))} disabled={readOnlyRecovery} />
                <div><span>{item.status === "draft" ? "Unsent draft" : item.reason === "thread_active" ? "Waiting for this task" : "Waiting for capacity"} · {activeThread.scope} · {profiles.find((profile) => profile.id === item.requestedProfileId)?.name ?? "No profile"} · {new Date(item.submittedAt).toLocaleTimeString()}</span>{index > 0 && <button type="button" onClick={() => void invoke(createCommand({ command: "execution_queue.reorder", payload: { itemId: item.id, beforeItemId: items[index - 1]!.id } }))}>Up</button>}{item.status === "draft" && <button type="button" onClick={() => void invoke(createCommand({ command: "execution_queue.activate", payload: { itemId: item.id } }))}>Send</button>}<button type="button" onClick={() => void invoke(createCommand({ command: "execution_queue.cancel", payload: { itemId: item.id } }))}>Cancel</button></div>
              </div>)}
            </div>}
            {activeConversationQuotes.length > 0 && <div className="conversation-quotes" aria-label="Conversation Quotes">
              {activeConversationQuotes.map((quote, index) => <div className="conversation-quote" key={quote.id}>
                <div><strong>Conversation Quote</strong><span>{quote.role} · Turn {quote.turnId.slice(0, 8)}</span></div>
                <p className="conversation-quote-text" title={quote.text}>{conversationQuotePreview(quote.text)}</p>
                <button type="button" aria-label="Remove conversation quote" title={`Remove Conversation Quote ${index + 1}`} onClick={() => removeConversationQuote(quote.id)}>×</button>
              </div>)}
            </div>}
            {composerSuggestionMatch !== null && <div className="composer-suggestions" role="listbox" aria-label={
              composerSuggestionMatch.suggestions[0]?.kind === "file" ? "Project files"
                : composerSuggestionMatch.suggestions[0]?.kind === "profile" ? "Model Profiles"
                  : composerSuggestionMatch.suggestions[0]?.kind === "thinking" ? "Reasoning levels"
                    : "Slash commands"
            }>
              {composerSuggestionMatch.suggestions.map((suggestion, index) => <button
                key={suggestion.id}
                type="button"
                role="option"
                aria-selected={index === composerSuggestionIndex}
                className={index === composerSuggestionIndex ? "active" : ""}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => chooseComposerSuggestion(suggestion)}
              ><strong>{suggestion.label}</strong><span>{suggestion.description}</span></button>)}
            </div>}
            <textarea ref={composerInput} aria-label="Message" aria-autocomplete="list" aria-expanded={composerSuggestionMatch !== null} placeholder={readOnlyRecovery ? "Read-only Recovery" : hasActiveTurn ? "Queue a follow-up" : "Ask vc-agent"} value={prompt} onChange={(event) => {
              setPrompt(event.target.value);
              setComposerCursor(event.target.selectionStart);
              setComposerSuggestionIndex(0);
            }} onClick={(event) => {
              setComposerCursor(event.currentTarget.selectionStart);
              setComposerSuggestionIndex(0);
            }} onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (composerSuggestionMatch !== null) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const direction = event.key === "ArrowDown" ? 1 : -1;
                  setComposerSuggestionIndex((current) => (current + direction + composerSuggestionMatch.suggestions.length) % composerSuggestionMatch.suggestions.length);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setComposerCursor(null);
                  return;
                }
                if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
                  event.preventDefault();
                  const selected = composerSuggestionMatch.suggestions[Math.min(composerSuggestionIndex, composerSuggestionMatch.suggestions.length - 1)]!;
                  const executesImmediately = selected.kind === "command"
                    && prompt.trim() === selected.value
                    && selected.value !== "/model"
                    && selected.value !== "/thinking";
                  if (executesImmediately && event.key === "Enter") void submit();
                  else chooseComposerSuggestion(selected);
                  return;
                }
              }
              if (event.key !== "Enter" || event.shiftKey) return;
              event.preventDefault();
              if (prompt.trim().length > 0) void submit();
            }} disabled={readOnlyRecovery} />
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

function ReflectionWorkspace({ run, finish, discard }: { run: ReflectionRun; finish(): void; discard(): void }) {
  const dialogueActive = run.status === "dialogue_active";
  const running = run.status.endsWith("_running");
  const terminal = run.status === "completed" || run.status === "discarded";
  const status = reflectionStatusLabel(run.status);
  return <article className="reflection-workspace" data-testid="reflection-workspace">
    <div className="reflection-summary"><div><span className={`reflection-status reflection-status-${run.status}`}>{status}</span><h2>{run.framing === "retrospective" ? "Investment Retrospective" : "Investment Reflection"}</h2><p>{run.objective}</p>{run.focus && <p><strong>Focus:</strong> {run.focus}</p>}</div><dl><div><dt>Brief</dt><dd>{run.brief.scope === "project" ? `${run.brief.materialCards.length} materials` : `${run.brief.userInputs.length} inputs`} · {run.brief.recordReferences.length} records</dd></div><div><dt>Prompt</dt><dd>{run.promptSnapshot.hash.slice(0, 12)}</dd></div><div><dt>Created</dt><dd>{new Date(run.createdAt).toLocaleString()}</dd></div></dl></div>
    {run.failure !== undefined && <div className="reflection-failure" role="alert"><strong>{run.failure.code}</strong><p>{run.failure.message}</p>{run.failure.requestId && <span>Request {run.failure.requestId}</span>}</div>}
    {!terminal && <div className="reflection-controls">{dialogueActive ? <><span>Reflection dialogue is active. Finish when the judgment is ready for review.</span><button className="primary-button" type="button" onClick={finish}>Finish Reflection</button></> : running ? <span>Preparing Reflection...</span> : <span>Reflection is {status.toLocaleLowerCase()}. You can discard it and start again if needed.</span>}<button type="button" onClick={discard}>Discard Reflection</button></div>}
  </article>;
}


function DelegationSettings({ projections, runProjections, taskDetails, activeThread, activeProfile, invoke, readOnly }: { projections: Record<string, SubAgentProjection>; runProjections: Record<string, SubAgentRunProjection>; taskDetails: Record<string, SubAgentTaskDetailProjection>; activeThread: Thread | undefined; activeProfile: ModelProfile | undefined; invoke(command: HostCommand): Promise<unknown>; readOnly: boolean }) {
  const [objective, setObjective] = useState("Find independent evidence for the current bounded question.");
  const [role, setRole] = useState<"researcher" | "critic" | "synthesizer" | "writer">("researcher");
  type FullTask = SubAgentProjection["tasks"][number];
  type SummaryTask = SubAgentRunProjection["tasks"][number];
  type DelegationTask = {
    id: string;
    runId: string;
    role: string;
    status: string;
    objective: string;
    usage: { totalTokens: number };
    handoff: FullTask["handoff"];
    attemptCount: number;
    resolvedProfile?: FullTask["resolvedProfile"];
    capabilitySet?: FullTask["capabilitySet"];
  };
  type DelegationRun = { run: SubAgentRunProjection["run"]; tasks: DelegationTask[] };
  const normalizeTask = (task: FullTask | SummaryTask): DelegationTask => {
    const detail = taskDetails[task.id];
    const full = detail?.task;
    return {
      id: task.id,
      runId: task.runId,
      role: task.role,
      status: task.status,
      objective: task.objective,
      usage: task.usage,
      handoff: full?.handoff ?? task.handoff,
      attemptCount: full?.attemptIds.length ?? ("attemptCount" in task ? task.attemptCount : task.attemptIds.length),
      ...(full === undefined ? {} : { resolvedProfile: full.resolvedProfile, capabilitySet: full.capabilitySet })
    };
  };
  const summaryRuns = Object.values(runProjections);
  const runs: DelegationRun[] = (summaryRuns.length > 0 ? summaryRuns : Object.values(projections)).map((projection) => ({ run: projection.run, tasks: projection.tasks.map(normalizeTask) })).sort((a, b) => b.run.updatedAt.localeCompare(a.run.updatedAt));
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
     {runs.length === 0 ? <p className="empty-setting">No explicit Sub-Agent runs.</p> : runs.map((projection) => <div className="delegation-run" key={projection.run.id}><header><div><strong>{projection.run.status}</strong><span>{projection.run.id.slice(0, 8)} · parent {projection.run.parentThreadId}</span></div><div className="form-actions">{!readOnly && ["authorized", "queued", "running"].includes(projection.run.status) && <button type="button" onClick={() => void invoke(createCommand({ command: "sub_agent.run.stop", payload: { runId: projection.run.id } }))}>Stop run</button>}{!readOnly && <button type="button" onClick={() => void invoke(createCommand({ command: "sub_agent.record.delete", payload: { runId: projection.run.id, confirmed: true } }))}>Delete record</button>}</div></header><span>Budget {projection.run.usage.totalTokens}{projection.run.sharedTokenBudget === undefined ? "" : ` / ${projection.run.sharedTokenBudget}`} tokens · {projection.tasks.length} task(s)</span>{projection.tasks.map((task) => { const detail = taskDetails[task.id]; return <div className="delegation-task" key={task.id}><div><strong>{task.role}</strong><span>{task.status} · {task.resolvedProfile === undefined ? "Profile details collapsed" : `${task.resolvedProfile.provider}/${task.resolvedProfile.model}`}</span><span title={task.objective}>{task.objective}</span><small>{task.capabilitySet?.join(", ") ?? "Capability set collapsed"} · {task.usage.totalTokens} tokens · {task.attemptCount} Attempt(s)</small></div><div className="form-actions"><button type="button" onClick={() => void invoke(createCommand({ command: "sub_agent.task.inspect", payload: { runId: projection.run.id, taskId: task.id } }))}>{detail === undefined ? "Load Task details" : "Refresh Task details"}</button>{!readOnly && ["failed", "interrupted", "stopped"].includes(task.status) && <button type="button" onClick={() => void invoke(createCommand({ command: "sub_agent.task.retry", payload: { taskId: task.id } }))}>Retry</button>}{!readOnly && ["created", "queued", "failed", "interrupted", "stopped"].includes(task.status) && <button type="button" onClick={() => void invoke(createCommand({ command: "sub_agent.task.skip", payload: { taskId: task.id } }))}>Skip</button>}{!readOnly && task.handoff !== undefined && task.handoff.reviewStatus === undefined && <><button type="button" onClick={() => void invoke(createCommand({ command: "sub_agent.handoff.adopt", payload: { taskId: task.id } }))}>Adopt handoff</button><button type="button" onClick={() => void invoke(createCommand({ command: "sub_agent.handoff.reject", payload: { taskId: task.id } }))}>Reject handoff</button></>}</div>{task.handoff !== undefined && <span role="status">Handoff {task.handoff.reviewStatus === "adopted" ? "adopted" : task.handoff.reviewStatus === "rejected" ? "rejected" : "awaiting parent adoption"} · {task.handoff.provenance.map((item) => item.referenceId).join(", ")}</span>}{detail !== undefined && <details className="delegation-attempts" open><summary>Task details · {detail.attempts.length} Attempt(s)</summary>{detail.attempts.map((attempt) => <span key={attempt.id}>{attempt.status} · {attempt.messages.length} message(s) · {attempt.toolEvents.length} tool event(s)</span>)}</details>}</div>; })}</div>)}
  </div>;
}

type IntegrationsSettingsProps = { state: IntegrationState | null; invoke(command: HostCommand): Promise<unknown>; readOnly: boolean; profiles: ModelProfile[]; projects: Project[]; materialsByProject: Record<string, MaterialInventoryItem[]>; activeThread: Thread | undefined; activeProfile: ModelProfile | undefined; integrationContext: IntegrationTaskContext };

/**
 * Office, Skill Creator, and Page Recovery remain protected product workflows.
 * They are intentionally separate from the Pi-native resource settings above:
 * none of the controls below register, activate, or authorize generic Skills,
 * MCP servers, or Extensions.
 */
function PiWorkflowIntegrationsSettings({ state, invoke, readOnly, profiles, projects, materialsByProject, activeThread, activeProfile, integrationContext }: IntegrationsSettingsProps) {
  const project = activeThread?.scope === "project" ? projects.find((item) => item.id === activeThread.projectId) : undefined;
  const profile = activeProfile;
  const [officeSourcePath, setOfficeSourcePath] = useState("");
  const [officeKind, setOfficeKind] = useState<"create" | "edit" | "review">("create");
  const [officeFormat, setOfficeFormat] = useState<"docx" | "pptx" | "xlsx" | "pdf">("docx");
  const [officeOutputName, setOfficeOutputName] = useState("");
  const [officeSkillName, setOfficeSkillName] = useState("docx");
  const [officeReplacementConfirmations, setOfficeReplacementConfirmations] = useState<Record<string, boolean>>({});
  const [skillPackageId, setSkillPackageId] = useState("");
  const [skillOperation, setSkillOperation] = useState<"create" | "update">("create");
  const [skillTargetName, setSkillTargetName] = useState("");
  const [skillName, setSkillName] = useState("");
  const [skillDescription, setSkillDescription] = useState("");
  const [skillObjective, setSkillObjective] = useState("");
  const [skillConstraints, setSkillConstraints] = useState("");
  const [skillDependencies, setSkillDependencies] = useState("");
  const officeNeedsSource = officeKind !== "create";
  const material = project === undefined ? undefined : materialsByProject[project.id]?.find((item) => item.mediaType === "application/pdf");
  const officeMissing = missingIntegrationContext(integrationContext, ["projectId", "threadId", "turnId", "profileId"]);
  const chooseOfficeSource = async () => {
    const result = await invoke(createCommand({ command: "office.source.choose", payload: { format: officeFormat } }));
    if (typeof result === "object" && result !== null && "event" in result && (result as { event?: unknown }).event === "office.source.selected") {
      const path = (result as { payload?: { path?: unknown } }).payload?.path;
      if (typeof path === "string") setOfficeSourcePath(path);
    }
  };
  const prepareOffice = () => {
    if (officeSkillName.trim() === "" || project === undefined || activeThread === undefined || profile === undefined || integrationContext.turnId === undefined || (officeNeedsSource && officeSourcePath === "")) return;
    void invoke(createCommand({ command: "office.task.prepare", payload: {
      kind: officeKind,
      format: officeFormat,
      projectId: project.id,
      projectPath: project.path,
      threadId: activeThread.id,
      turnId: integrationContext.turnId,
      profile: { id: profile.id, provider: profile.provider, model: profile.model },
      skillName: officeSkillName.trim(),
      outputDirectory: `${project.path}/outputs`,
      ...(officeOutputName.trim() === "" ? {} : { outputFileName: officeOutputName.trim() }),
      ...(officeNeedsSource ? { sourcePath: officeSourcePath, sourceReferences: ["settings:office-source"], renderPreview: true } : {}),
      explicitIntent: true
    } }));
  };
  const createDraft = () => {
    if (skillPackageId.trim() === "" || skillName.trim() === "" || skillDescription.trim() === "" || skillObjective.trim() === "" || (skillOperation === "update" && skillTargetName.trim() === "")) return;
    void invoke(createCommand({ command: "skill_creator.prepare", payload: {
      operation: skillOperation,
      explicitIntent: true,
      packageId: skillPackageId.trim(),
      ...(profile === undefined ? {} : { profileId: profile.id }),
      ...(skillOperation === "update" ? { targetSkillName: skillTargetName.trim() } : {}),
      files: { "SKILL.md": `---\nname: ${skillName.trim()}\ndescription: ${skillDescription.trim()}\n---\n# ${skillName.trim()}\n\n## Objective\n${skillObjective.trim()}\n\n## Constraints\n${skillConstraints.trim() || "None specified."}\n`, "LICENSE": "User review required." },
      ...(skillDependencies.trim() === "" ? {} : { dependencies: skillDependencies.split(",").map((item) => item.trim()).filter(Boolean) })
    } }));
  };
  const runParse = () => {
    if (project === undefined || material === undefined) return;
    void invoke(createCommand({ command: "page_recovery.run", payload: { materialId: material.id, projectId: project.id, relativePath: material.relativePath, mediaType: material.mediaType, sourceHash: material.sourceHash } }));
  };
  return <div className="settings-section integrations-settings" data-testid="integrations-settings">
    <div className="settings-section-header"><div><span className="eyebrow">Protected workflows</span><h2>Office, Skill Creator, and Page Recovery</h2><p>These workflows retain their product-specific validation and durable-commit controls. Generic Pi resources are managed above.</p></div><button className="compact-button" type="button" onClick={() => void invoke(createCommand({ command: "integration.state.load" }))}>Refresh status</button></div>
    <div className="integration-task-context" data-testid="integration-task-context" role="status"><strong>Selected task context</strong><span>Project: {project?.displayName ?? "Not selected"}</span><span>Thread: {activeThread?.title ?? "Not selected"}</span><span>Parent Turn: {integrationContext.turnId ?? "Not available"}</span><span>Profile: {profile === undefined ? "Not selected" : `${profile.provider} / ${profile.model}`}</span><span>Access: {integrationContext.accessMode}</span></div>
    {state === null ? <p>Loading protected workflow state...</p> : <>
      <div className="integration-grid">
        <IntegrationCard title="Office Skills" status={state.office.status} message={state.office.status.message} className="office-integration-card">
          <span>{state.office.activeSkillCount} active Office Skill package(s) · {state.office.supportedFormats.join(", ")}</span>
          <span>{state.office.jobs.length} task record(s)</span>
          {officeMissing.length > 0 && <span role="status">Office actions require: {officeMissing.join(", ")}.</span>}
          <span>Enter the Skill name exactly as it appears in the dedicated VC Agent Skills Directory.</span>
          <div className="integration-form-grid">
            <label>Office operation<select aria-label="Office operation" value={officeKind} onChange={(event) => { const kind = event.target.value as typeof officeKind; setOfficeKind(kind); if (kind === "create") setOfficeSourcePath(""); }}><option value="create">Create</option><option value="edit">Edit</option><option value="review">Review</option></select></label>
            <label>Office format<select aria-label="Office format" value={officeFormat} onChange={(event) => { setOfficeFormat(event.target.value as typeof officeFormat); setOfficeSourcePath(""); }}><option value="docx">DOCX</option><option value="pptx">PPTX</option><option value="xlsx">XLSX</option><option value="pdf">PDF</option></select></label>
            <label>Office Skill name<input aria-label="Office Skill name" value={officeSkillName} onChange={(event) => setOfficeSkillName(event.target.value)} placeholder="docx" /></label>
            <label>Output name<input aria-label="Office output name" value={officeOutputName} onChange={(event) => setOfficeOutputName(event.target.value)} placeholder={officeKind === "create" ? "generated-output" : officeKind === "review" ? "reviewed-copy" : "edited-copy"} /></label>
          </div>
          {officeNeedsSource && <div className="integration-inline-row"><input aria-label="Office source path" value={officeSourcePath} readOnly placeholder={`Choose an existing ${officeFormat.toUpperCase()} source`} /><button type="button" onClick={() => void chooseOfficeSource()}>Choose source</button></div>}
          <button className="primary-button" type="button" onClick={prepareOffice} disabled={readOnly || officeSkillName.trim() === "" || officeMissing.length > 0 || (officeNeedsSource && officeSourcePath === "")}>Prepare Office task</button>
          {state.office.jobs.map((job) => <div className="integration-office-job" key={job.id}>
            <div className="integration-inline-row"><span>{job.kind} · {job.format ?? "unknown"} · {job.state}</span><span>{job.message}</span></div>
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
        <IntegrationCard title="Skill Creator" status={state.skillCreator.status} message={state.skillCreator.status.message}>
          <span>{state.skillCreator.drafts.length} draft(s)</span><span>Creator Profile: {profile === undefined ? "Not selected" : `${profile.provider} / ${profile.model}`}</span>
          <div className="integration-form-grid"><select aria-label="Skill operation" value={skillOperation} onChange={(event) => setSkillOperation(event.target.value as typeof skillOperation)}><option value="create">Create</option><option value="update">Update</option></select>{skillOperation === "update" && <input aria-label="Skill target name" value={skillTargetName} onChange={(event) => setSkillTargetName(event.target.value)} placeholder="Existing Skill name" />}<input aria-label="Skill package id" value={skillPackageId} onChange={(event) => setSkillPackageId(event.target.value)} placeholder="Package id" /><input aria-label="Skill name" value={skillName} onChange={(event) => setSkillName(event.target.value)} placeholder="Name" /><input aria-label="Skill description" value={skillDescription} onChange={(event) => setSkillDescription(event.target.value)} placeholder="Description" /><textarea aria-label="Skill objective" value={skillObjective} onChange={(event) => setSkillObjective(event.target.value)} placeholder="Objective" /><textarea aria-label="Skill constraints" value={skillConstraints} onChange={(event) => setSkillConstraints(event.target.value)} placeholder="Constraints" /><input aria-label="Skill dependencies" value={skillDependencies} onChange={(event) => setSkillDependencies(event.target.value)} placeholder="Dependencies, comma separated" /></div>
          {!readOnly && <button type="button" onClick={createDraft} disabled={profile === undefined || !skillPackageId.trim() || !skillName.trim() || !skillDescription.trim() || !skillObjective.trim() || (skillOperation === "update" && !skillTargetName.trim())}>Create explicit draft</button>}
          {state.skillCreator.drafts.map((draft) => <div className="integration-inline-row" key={draft.draftId}><span>{draft.packageId} · {draft.operation} · {draft.state}</span>{draft.state === "draft_ready" && <button type="button" onClick={() => void invoke(createCommand({ command: "skill_creator.review", payload: { draftId: draft.draftId } }))}>Review</button>}{!readOnly && ["draft_ready", "reviewed"].includes(draft.state) && <button type="button" onClick={() => void invoke(createCommand({ command: "skill_creator.handoff", payload: { draftId: draft.draftId, confirmed: true, accessMode: integrationContext.accessMode } }))}>Hand off to protected runner</button>}</div>)}
        </IntegrationCard>
        <IntegrationCard title="Page Recovery / OCR" status={state.pageRecovery.status} message={state.pageRecovery.status.message}>
          <span>Native: {state.pageRecovery.availability.native.status} · Paddle: {state.pageRecovery.availability.paddle.status} · Ovis: {state.pageRecovery.availability.ovis.status}</span><span>Policy {state.pageRecovery.availability.policyRevision} · {state.pageRecovery.telemetry.lastStatus}</span>
          <div className="integration-inline-row"><button type="button" onClick={() => void invoke(createCommand({ command: "page_recovery.inspect" }))}>Inspect availability</button><button type="button" onClick={runParse} disabled={readOnly || project === undefined || material === undefined}>Run Page Recovery</button></div>
          {state.pageRecovery.lastParse !== undefined && <div className="integration-page-results" role="status"><strong>Last Parse · per-page retained result</strong>{state.pageRecovery.lastParse.pages.map((page) => <span key={page.pageNumber}>Page {page.pageNumber}: {page.selectedStage}{page.retainedEarlier ? " · retained earlier result" : ""}{page.warningCodes.length === 0 ? "" : ` · ${page.warningCodes.join(", ")}`}</span>)}</div>}
          {state.pageRecovery.parses.map((job) => <div className="integration-inline-row" key={job.id}><span>{job.kind} · {job.state} · {job.message}</span>{job.state === "running" && <button type="button" onClick={() => void invoke(createCommand({ command: "page_recovery.cancel", payload: { parseId: job.id } }))}>Cancel Parse</button>}</div>)}
        </IntegrationCard>
      </div>
      {state.runtime.runningJobs > 0 && <p className="integration-runtime-status" role="status">{state.runtime.runningJobs} protected workflow job(s) active · {state.runtime.queuedJobs} queued · {state.runtime.failures} failure(s) retained.</p>}
    </>}
  </div>;
}

function IntegrationsSettings({ state, invoke, readOnly, profiles, projects, materialsByProject, activeThread, activeProfile, integrationContext }: IntegrationsSettingsProps) {
  return <PiWorkflowIntegrationsSettings state={state} invoke={invoke} readOnly={readOnly} profiles={profiles} projects={projects} materialsByProject={materialsByProject} activeThread={activeThread} activeProfile={activeProfile} integrationContext={integrationContext} />;
}

function basenameForUi(path: string): string {
  return path.split(/[\\/]/u).at(-1) ?? path;
}

function IntegrationCard({ title, status, message, children, className = "" }: { title: string; status: { status: "ready" | "attention" | "unavailable" }; message: string; children: React.ReactNode; className?: string }) {
  return <section className={`integration-card ${className}`.trim()}><header><h3>{title}</h3><span className={`doctor-status ${status.status}`}>{status.status}</span></header><p>{message}</p><div>{children}</div></section>;
}

function reflectionStatusLabel(status: ReflectionRun["status"]): string {
  if (status === "awaiting_profile") return "Awaiting profile";
  if (status === "ready") return "Ready";
  if (status === "dialogue_active") return "Dialogue active";
  if (status === "completed") return "Review ready";
  if (status === "discarded") return "Discarded";
  if (status.endsWith("_running")) return "Preparing Reflection";
  if (status.endsWith("_failed")) return "Reflection failed";
  if (status.endsWith("_interrupted")) return "Reflection interrupted";
  return "Reflection";
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

function SettingsView({ bootstrap, profiles, academicCredentials, taskAssignments, projects, materialsByProject, integrationState, piResourcesState, subAgentProjections, subAgentRunProjections, subAgentTaskDetails, activeThreadId, activeThread, activeProfile, integrationContext, promptRevisions, activePromptRevisionId, formOpen, setFormOpen, invoke, readOnly, recoveryExport, personalCognitionNotice, learningTelemetry, longTermMemoryDocument, longTermMemoryDraft, memoryMaintenance, memoryReviewProgress, memoryReviewPolicy, openMemoryReview, onLongTermMemoryChange, onLongTermMemoryRefresh }: {
  bootstrap: BootstrapState | null;
  profiles: ModelProfile[];
  academicCredentials: AcademicCredentialStatus[];
  taskAssignments: TaskModelAssignment[];
  projects: Project[];
  materialsByProject: Record<string, MaterialInventoryItem[]>;
  integrationState: IntegrationState | null;
  piResourcesState: PiResourcesSettingsState | null;
  subAgentProjections: Record<string, SubAgentProjection>;
  subAgentRunProjections: Record<string, SubAgentRunProjection>;
  subAgentTaskDetails: Record<string, SubAgentTaskDetailProjection>;
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
  memoryMaintenance: MemoryMaintenanceState | null;
  memoryReviewProgress: MemoryReviewProgress | null;
  memoryReviewPolicy: AutoMemoryReviewPolicy | null;
  openMemoryReview(): void;
  onLongTermMemoryChange(content: string): void;
  onLongTermMemoryRefresh(): void;
}) {
  const [tab, setTab] = useState<"general" | "memory">("general");
  const [name, setName] = useState("");
  const [providerMode, setProviderMode] = useState<"builtin" | "url">("builtin");
  const [builtinProvider, setBuiltinProvider] = useState("");
  const [providerUrl, setProviderUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState<ModelProfile["thinkingLevel"]>("off");
  const [contextWindow, setContextWindow] = useState("");
  const [maxOutputTokens, setMaxOutputTokens] = useState("");
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [credentialProfileId, setCredentialProfileId] = useState<string | null>(null);
  const [replacementCredential, setReplacementCredential] = useState("");
  const [academicCredentialDrafts, setAcademicCredentialDrafts] = useState<Record<AcademicCredentialSource, string>>({ openalex: "", github: "", huggingface: "" });
  const [academicCredentialNotice, setAcademicCredentialNotice] = useState<string | null>(null);
  const builtinProviders = bootstrap?.piProviders ?? [];
  const selectableBuiltinProviders = [...new Set([...(builtinProvider ? [builtinProvider] : []), ...builtinProviders])];
  const provider = providerMode === "builtin" ? builtinProvider : providerUrl;
  const providerValid = providerMode === "builtin" ? builtinProvider.trim().length > 0 : isProviderUrl(providerUrl);
  const parsedContextWindow = contextWindow === "" ? undefined : Number(contextWindow);
  const parsedMaxOutputTokens = maxOutputTokens === "" ? undefined : Number(maxOutputTokens);
  const limitsValid =
    (parsedContextWindow === undefined || (Number.isInteger(parsedContextWindow) && parsedContextWindow >= 1_024)) &&
    (parsedMaxOutputTokens === undefined || (Number.isInteger(parsedMaxOutputTokens) && parsedMaxOutputTokens >= 1)) &&
    (parsedContextWindow === undefined || parsedMaxOutputTokens === undefined || parsedMaxOutputTokens < parsedContextWindow);
  const valid = Boolean(name.trim() && providerValid && model.trim() && (editingProfileId !== null || apiKey) && limitsValid);
  const resetProfileForm = () => {
    setEditingProfileId(null);
    setName(""); setProviderMode("builtin"); setBuiltinProvider(builtinProviders[0] ?? ""); setProviderUrl(""); setModel(""); setApiKey(""); setThinkingLevel("off"); setContextWindow(""); setMaxOutputTokens("");
  };
  const editProfile = (profile: ModelProfile) => {
    setEditingProfileId(profile.id);
    setName(profile.name);
    if (isProviderUrl(profile.provider)) {
      setProviderMode("url");
      setProviderUrl(profile.provider);
    } else {
      setProviderMode("builtin");
      setBuiltinProvider(profile.provider);
    }
    setModel(profile.model);
    setApiKey("");
    setThinkingLevel(profile.thinkingLevel);
    setContextWindow(profile.contextWindow === undefined ? "" : String(profile.contextWindow));
    setMaxOutputTokens(profile.maxOutputTokens === undefined ? "" : String(profile.maxOutputTokens));
    setFormOpen(true);
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    const limits = {
      ...(parsedContextWindow === undefined ? {} : { contextWindow: parsedContextWindow }),
      ...(parsedMaxOutputTokens === undefined ? {} : { maxOutputTokens: parsedMaxOutputTokens })
    };
    const command = editingProfileId === null
      ? createCommand({ command: "profile.create", payload: { name, provider, model, apiKey, thinkingLevel, ...limits } })
      : createCommand({ command: "profile.update", payload: { profileId: editingProfileId, name, provider, model, thinkingLevel, ...limits, ...(apiKey ? { apiKey } : {}) } });
    void invoke(command).then(() => {
      resetProfileForm();
      setFormOpen(false);
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
  const saveAcademicCredential = (source: AcademicCredentialSource) => {
    const credential = academicCredentialDrafts[source];
    if (credential.length === 0) return;
    void invoke(createCommand({ command: "academic.credentials.set", payload: { source, credential } })).then(() => {
      setAcademicCredentialDrafts((current) => ({ ...current, [source]: "" }));
      setAcademicCredentialNotice(`${academicCredentialLabel(source)} credential saved.`);
    });
  };
  const clearAcademicCredential = (source: AcademicCredentialSource) => {
    void invoke(createCommand({ command: "academic.credentials.clear", payload: { source } })).then(() => {
      setAcademicCredentialDrafts((current) => ({ ...current, [source]: "" }));
      setAcademicCredentialNotice(`${academicCredentialLabel(source)} credential removed.`);
    });
  };
  return (
    <section className="settings-view" aria-labelledby="settings-title">
      <header><div><span className="eyebrow">Application</span><h1 id="settings-title">Settings</h1></div><SlidersHorizontal size={20} /></header>
      <div className="settings-tabs" role="tablist" aria-label="Settings views"><button type="button" role="tab" aria-selected={tab === "general"} className={tab === "general" ? "active" : ""} onClick={() => setTab("general")}>General</button><button type="button" role="tab" aria-selected={tab === "memory"} className={tab === "memory" ? "active" : ""} onClick={openMemory} disabled={readOnly}>Memory</button></div>
      {tab === "memory" ? <div className="memory-settings-stack"><MemoryReviewSettings progress={memoryReviewProgress} policy={memoryReviewPolicy} profileId={taskAssignments.find((item) => item.taskType === "memory_review")?.profileId} invoke={invoke} prepare={openMemoryReview} readOnly={readOnly} /><LongTermMemorySettings document={longTermMemoryDocument} draft={longTermMemoryDraft} maintenance={memoryMaintenance} invoke={invoke} onChange={onLongTermMemoryChange} onRefresh={onLongTermMemoryRefresh} onSave={saveLongTermMemory} openFolder={() => void invoke(createCommand({ command: "long_term_memory.open_folder" }))} /></div> : <>
      {readOnly && <div className="settings-section recovery-export"><h2>Recovery export</h2><p>Raw state may contain encrypted credentials and sensitive local metadata. Its destination determines its security.</p><button className="compact-button" type="button" onClick={() => void invoke(createCommand({ command: "state.recovery.export" }))}>Export raw state</button>{recoveryExport && <span title={recoveryExport}>{recoveryExport}</span>}</div>}
      <fieldset className="settings-write-controls" disabled={readOnly}>
      <div className="settings-section personal-cognition-settings"><div className="settings-section-header"><div><h2>Personal Cognition Backup</h2><p>Portable, checksummed cognition only. Projects, workflow state, trajectories, and credentials are excluded.</p></div></div><div className="form-actions"><button type="button" onClick={() => void invoke(createCommand({ command: "personal_cognition.restore" }))}>Restore backup</button><button className="primary-button" type="button" onClick={() => void invoke(createCommand({ command: "personal_cognition.backup.create" }))}>Create backup</button></div>{personalCognitionNotice && <span role="status" title={personalCognitionNotice}>{personalCognitionNotice}</span>}</div>
      {piResourcesState === null ? <div className="settings-section pi-resources-settings" data-testid="pi-resources-settings"><p>Loading Pi-native resources...</p></div> : <PiResourcesSettings
        state={piResourcesState}
        disabled={readOnly}
        actions={{
          onOpenExtensionsFolder: async () => { await invoke(createCommand({ command: "pi.resources.open", payload: { target: "extensions_folder" } })); },
          onOpenMcpConfig: async () => { await invoke(createCommand({ command: "pi.resources.open", payload: { target: "mcp_config" } })); },
          onOpenSkillsFolder: async () => { await invoke(createCommand({ command: "pi.resources.open", payload: { target: "skills_folder" } })); },
          onImportSkill: async () => { await invoke(createCommand({ command: "pi.resources.import_skill" })); },
          onReload: async () => { await invoke(createCommand({ command: "pi.resources.reload" })); },
          onSetProjectResourcesTrusted: async (trusted) => {
            await invoke(createCommand({ command: "pi.resources.project_trust.set", payload: { trusted } }));
          }
        }}
      />}
      <div className="settings-section academic-credential-settings">
        <div className="settings-section-header"><div><h2>Academic Research Sources</h2><p>Credentials are encrypted by Windows and are never exposed back to the interface. arXiv does not require a credential.</p></div></div>
        <div className="academic-credential-list">
          {(["openalex", "github", "huggingface"] as const).map((source) => {
            const configured = academicCredentials.find((item) => item.source === source)?.configured === true;
            return <div className="academic-credential-row" key={source}>
              <div className="academic-credential-copy"><strong>{academicCredentialLabel(source)}</strong><span>{academicCredentialDescription(source)}</span><span className={configured ? "credential-ready" : "credential-missing"}>{configured ? "Configured" : "Not configured"}</span></div>
              <div className="academic-credential-actions"><span className="secret-input"><KeyRound size={14} /><input aria-label={`${academicCredentialLabel(source)} credential`} type="password" value={academicCredentialDrafts[source]} onChange={(event) => setAcademicCredentialDrafts((current) => ({ ...current, [source]: event.target.value }))} autoComplete="off" placeholder={configured ? "Enter replacement credential" : "Enter credential"} /></span><button type="button" disabled={academicCredentialDrafts[source].length === 0} onClick={() => saveAcademicCredential(source)}>{configured ? "Replace" : "Save"}</button>{configured && <button type="button" onClick={() => clearAcademicCredential(source)}>Remove</button>}</div>
            </div>;
          })}
        </div>
        {academicCredentialNotice !== null && <span role="status">{academicCredentialNotice}</span>}
      </div>
      <div className="settings-section profile-settings">
        <div className="settings-section-header"><div><h2>Model Profiles</h2><p>Credentials are protected by Windows and stored only by reference.</p></div><button className="compact-button" type="button" onClick={() => { resetProfileForm(); setFormOpen(!formOpen); }}><Plus size={15} /> New profile</button></div>
        {formOpen && <form className="profile-form" onSubmit={save}>
          <label>Name<input value={name} onChange={(event) => setName(event.target.value)} autoFocus /></label>
          <label>Provider mode<select aria-label="Provider mode" value={providerMode} onChange={(event) => setProviderMode(event.target.value as "builtin" | "url")}><option value="builtin">Pi built-in provider</option><option value="url">Custom URL</option></select></label>
          {providerMode === "builtin" ? <label>Provider<select aria-label="Provider" value={builtinProvider} onChange={(event) => setBuiltinProvider(event.target.value)}><option value="" disabled>Select a Pi provider</option>{selectableBuiltinProviders.map((item) => <option key={item} value={item}>{item}</option>)}</select></label> : <label>Provider URL<input aria-label="Provider URL" value={providerUrl} onChange={(event) => setProviderUrl(event.target.value)} placeholder="https://api.example.com/v1" /></label>}
          <label>Model<input value={model} onChange={(event) => setModel(event.target.value)} placeholder="model id" /></label>
          <label>API key<span className="secret-input"><KeyRound size={14} /><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" placeholder={editingProfileId === null ? "" : "Leave blank to keep current key"} /></span></label>
          {providerMode === "url" && <span className="profile-provider-hint">URLs containing <code>anthropic</code> use the Anthropic API; other URLs use OpenAI-compatible API.</span>}
          <label>Reasoning<select value={thinkingLevel} onChange={(event) => setThinkingLevel(event.target.value as ModelProfile["thinkingLevel"])}><option value="off">Off</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
          <label>Context window override<input aria-label="Context window override" type="number" min={1024} step={1} value={contextWindow} onChange={(event) => setContextWindow(event.target.value)} placeholder="Auto from pi catalog" /></label>
          <label>Max output tokens override<input aria-label="Max output tokens override" type="number" min={1} step={1} value={maxOutputTokens} onChange={(event) => setMaxOutputTokens(event.target.value)} placeholder="Auto from pi catalog" /></label>
          {!limitsValid && <span className="profile-limit-error" role="alert">Use positive whole numbers; max output tokens must be smaller than the context window.</span>}
          <div className="form-actions"><button type="button" onClick={() => { resetProfileForm(); setFormOpen(false); }}>Cancel</button><button className="primary-button" type="submit" disabled={!valid}>Save profile</button></div>
        </form>}
        <div className="profile-list">{profiles.length === 0 ? <p className="empty-setting">No model profiles</p> : profiles.map((profile) => <div className="profile-row" key={profile.id}><div><strong>{profile.name}</strong><span>{profile.provider} / {profile.model}</span><span>Context {profile.contextWindow === undefined ? "auto" : formatExactTokenCount(profile.contextWindow)} · Output {profile.maxOutputTokens === undefined ? "auto" : formatExactTokenCount(profile.maxOutputTokens)}</span>{profile.credentialRef.startsWith("setup-required-") && <><span>Credential setup required after restore</span>{credentialProfileId === profile.id ? <span className="secret-input"><KeyRound size={14} /><input aria-label={`Credential for ${profile.name}`} type="password" value={replacementCredential} onChange={(event) => setReplacementCredential(event.target.value)} autoComplete="off" /><button type="button" disabled={!replacementCredential} onClick={() => void invoke(createCommand({ command: "profile.credential.set", payload: { profileId: profile.id, apiKey: replacementCredential } })).then(() => { setCredentialProfileId(null); setReplacementCredential(""); })}>Save credential</button></span> : <button type="button" onClick={() => setCredentialProfileId(profile.id)}>Set credential</button>}</>}</div><div className="profile-row-actions"><span>{profile.thinkingLevel}</span><button type="button" aria-label={`Edit ${profile.name}`} onClick={() => editProfile(profile)}>Edit</button></div></div>)}</div>
      </div>
      <div className="settings-section task-assignment-settings"><div className="settings-section-header"><div><h2>Task Model Assignments</h2><p>Workflow defaults for each product intent.</p></div></div>{TASK_MODEL_TYPES.map((task) => <label key={task.id}><span>{task.label}</span><select aria-label={task.ariaLabel ?? `${task.label} Profile`} value={taskAssignments.find((item) => item.taskType === task.id)?.profileId ?? ""} onChange={(event) => void invoke(createCommand(event.target.value === "" ? { command: "task_model_assignment.clear", payload: { taskType: task.id } } : { command: "task_model_assignment.set", payload: { taskType: task.id, profileId: event.target.value } }))}><option value="">Not assigned</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.provider}/{profile.model}</option>)}</select></label>)}</div>
      <PromptSettings revisions={promptRevisions} activeRevisionId={activePromptRevisionId} invoke={invoke} />
      <div className="settings-section"><h2>Access Mode</h2><div className="access-mode-control" role="group" aria-label="Access Mode"><button type="button" className={bootstrap?.accessMode === "standard" ? "active" : ""} onClick={() => void invoke(createCommand({ command: "access.mode.set", payload: { mode: "standard" } }))}>Standard</button><button type="button" className={bootstrap?.accessMode === "full" ? "active full" : ""} onClick={() => void invoke(createCommand({ command: "access.mode.set", payload: { mode: "full" } }))}>Full Access</button></div></div>
      </fieldset>
       <IntegrationsSettings state={integrationState} invoke={invoke} readOnly={readOnly} profiles={profiles} projects={projects} materialsByProject={materialsByProject} activeThread={activeThread} activeProfile={activeProfile} integrationContext={integrationContext} />
      <DelegationSettings projections={subAgentProjections} runProjections={subAgentRunProjections} taskDetails={subAgentTaskDetails} activeThread={activeThread} activeProfile={activeProfile} invoke={invoke} readOnly={readOnly} />
      <div className="settings-section"><h2>Local state</h2><dl><div><dt>Application version</dt><dd>{bootstrap?.applicationVersion ?? "Loading"}</dd></div><div><dt>Storage mode</dt><dd>{bootstrap?.storageMode ?? "Loading"}</dd></div><div><dt>State schema</dt><dd>{bootstrap?.stateSchemaVersion ?? "Loading"}</dd></div><div><dt>Supported schema</dt><dd>{bootstrap?.migration.supportedVersion ?? "Loading"}</dd></div><div><dt>Migration status</dt><dd>{bootstrap?.migration.status ?? "Loading"}</dd></div><div><dt>Rollback</dt><dd>{bootstrap?.migration.rollbackAvailable ? "Available" : "Unavailable"}</dd></div><div><dt>Projects</dt><dd>{bootstrap?.entityCounts.projects ?? 0}</dd></div><div><dt>Threads</dt><dd>{bootstrap?.entityCounts.threads ?? 0}</dd></div></dl></div>
      <div className="settings-section"><h2>Runtime</h2><dl><div><dt>Agent workers</dt><dd>{bootstrap?.runtimeActivity.agentWorkersStarted ?? 0}</dd></div><div><dt>Pi sessions</dt><dd>{bootstrap?.runtimeActivity.piSessionsStarted ?? 0}</dd></div><div><dt>Provider requests</dt><dd>{bootstrap?.runtimeActivity.providerRequests ?? 0}</dd></div><div><dt>Execution capacity</dt><dd>{bootstrap === null ? "-" : `${bootstrap.executionScheduler.runningCount} / ${bootstrap.executionScheduler.capacity}`}</dd></div><div><dt>Queued / drafts</dt><dd>{bootstrap === null ? "-" : `${bootstrap.executionScheduler.queuedCount} / ${bootstrap.executionScheduler.draftCount}`}</dd></div><div><dt>Average queue delay</dt><dd>{bootstrap?.executionScheduler.averageQueueDelayMs ?? 0} ms</dd></div><div><dt>Longest running</dt><dd>{bootstrap?.executionScheduler.longestRunningMs ?? 0} ms</dd></div><div><dt>Execution failures</dt><dd>{bootstrap?.executionScheduler.failureCount ?? 0}</dd></div></dl></div>
      <div className="settings-section learning-telemetry"><h2>Learning telemetry</h2><p>Turn details expose prompt, tools, retained context, recall, output reserve, token contribution, and latency.</p><dl><div><dt>Memory Review scope coverage</dt><dd>{learningTelemetry.coveredScopes} / {learningTelemetry.totalScopes}</dd></div><div><dt>Visible workflow failures</dt><dd>{learningTelemetry.failureCount}</dd></div><div><dt>Remote content telemetry</dt><dd>Disabled</dd></div></dl></div>
      <div className="settings-section"><h2>Environment Doctor</h2><dl>{bootstrap?.environmentDoctor === undefined ? <div><dt>Status</dt><dd>Loading</dd></div> : Object.entries(bootstrap.environmentDoctor).map(([name, diagnostic]) => <div key={name}><dt>{doctorLabel(name)}</dt><dd><span className={`doctor-status ${diagnostic.status}`}>{diagnostic.status}</span> {diagnostic.message}</dd></div>)}</dl></div>
      </>}
    </section>
  );
}

function MemoryReviewProgressPanel({ progress, onCancel }: { progress: MemoryReviewProgress; onCancel(): void }) {
  const ratio = progress.totalChunks > 0 ? Math.min(1, progress.completedChunks / progress.totalChunks) : progress.eligible > 0 ? Math.min(1, progress.processed / progress.eligible) : 0;
  return <section className="cognition-progress" data-testid="memory-review-progress" role="status"><div className="cognition-progress-heading"><strong>Memory Review {progress.status.replaceAll("_", " ")}</strong><span>{progress.processed} / {progress.eligible} eligible sources</span></div><progress max={1} value={ratio} aria-label="Memory Review progress" /><div className="cognition-progress-counts"><span>{progress.noSignal} no signal</span><span>{progress.represented} represented</span><span>{progress.carriedOver} carried over</span><span>{progress.completedChunks} / {progress.totalChunks} chunks</span></div>{progress.failureCode !== undefined && <span className="cognition-failure">{progress.failureCode}</span>}{progress.status === "preparing" && <button type="button" onClick={onCancel}>Cancel preparation</button>}</section>;
}

function CognitionReviewPanel({ bundle, onDecision, onCommit, onDiscard }: { bundle: ReviewBundle; onDecision(bundle: ReviewBundle, proposalId: string, decision: "adopt" | "defer" | "reject"): void; onCommit(reviewId: string): void; onDiscard(reviewId: string): void }) {
  const decisions = new Map(bundle.decisions.map((item) => [item.proposalId, item.decision]));
  const allDecided = bundle.proposals.every((proposal) => decisions.has(proposal.id));
  const terminal = ["committed", "discarded"].includes(bundle.status);
  return <section className={`cognition-review-panel ${bundle.kind}`} data-testid="cognition-review-panel" aria-labelledby="cognition-review-title">
    <header className="cognition-review-heading"><div><span className="eyebrow">Review Bundle</span><h2 id="cognition-review-title">{bundle.kind === "reflection" ? "Reflection Review" : "Memory Review"}</h2><span>{bundle.status.replaceAll("_", " ")}</span></div>{!terminal && <button type="button" onClick={() => onDiscard(bundle.id)}>Discard</button>}</header>
    {bundle.judgment !== undefined && <article className="cognition-judgment"><span>Judgment draft · not authoritative</span><h3>{bundle.judgment.title}</h3><p>{bundle.judgment.judgment}</p><details><summary>Rationale and uncertainty</summary>{bundle.judgment.rationale.map((item) => <p key={`rationale-${item}`}>{item}</p>)}{bundle.judgment.uncertainty.map((item) => <p key={`uncertainty-${item}`}>{item}</p>)}</details></article>}
    {bundle.proposals.length === 0 ? <p className="cognition-empty">No learning proposals were prepared. Review the judgment draft and confirm when ready.</p> : <div className="cognition-proposal-list">{bundle.proposals.map((proposal) => { const decision = decisions.get(proposal.id); return <article className="cognition-proposal-card" key={proposal.id}><header><div><strong>{proposal.title}</strong><span>{proposal.destination.replaceAll("_", " ")} · {proposal.action}</span></div><span className={`cognition-decision ${decision ?? "pending"}`}>{decision ?? "pending"}</span></header><p>{proposal.content}</p><details><summary>Sources and limits</summary><p>{proposal.limitations || "No limitations supplied."}</p><span>{proposal.sourceReferences.length} source reference(s)</span>{proposal.applicability.length > 0 && <span>Applies to: {proposal.applicability.join(", ")}</span>}</details>{!terminal && <div className="cognition-proposal-actions"><button type="button" className={decision === "reject" ? "selected" : ""} onClick={() => onDecision(bundle, proposal.id, "reject")}>Reject</button><button type="button" className={decision === "defer" ? "selected" : ""} onClick={() => onDecision(bundle, proposal.id, "defer")}>Defer</button><button type="button" className={`primary-button ${decision === "adopt" ? "selected" : ""}`} onClick={() => onDecision(bundle, proposal.id, "adopt")}>Adopt</button></div>}</article>; })}</div>}
    {bundle.patch !== undefined && <details className="cognition-patch-preview" open><summary>Patch preview · confirmation required</summary><p>Files are prepared from the current dependency hashes. No change is written until you confirm this Review Bundle.</p>{bundle.patch.files.map((file) => <div className="cognition-patch-file" key={file.path}><strong>{file.path}</strong><span>{file.baseHash.slice(0, 12)} → {file.afterHash.slice(0, 12)}</span></div>)}</details>}
    <details className="cognition-diagnostics"><summary>Diagnostics</summary>{bundle.coverage !== undefined && <dl><div><dt>Eligible</dt><dd>{bundle.coverage.eligibleCount}</dd></div><div><dt>No signal</dt><dd>{bundle.coverage.noSignalCount}</dd></div><div><dt>Represented</dt><dd>{bundle.coverage.representedCount}</dd></div><div><dt>Carried over</dt><dd>{bundle.coverage.carriedOverCount}</dd></div><div><dt>Complete</dt><dd>{bundle.coverage.complete ? "Yes" : "No"}</dd></div></dl>}<span>{bundle.dependencies.length} dependency snapshot(s)</span></details>
    {!terminal && <div className="cognition-review-actions"><button type="button" onClick={() => onDiscard(bundle.id)}>Discard</button><button className="primary-button" type="button" onClick={() => onCommit(bundle.id)} disabled={!allDecided || bundle.status === "stale"}>{bundle.kind === "reflection" ? "Confirm Reflection" : "Commit Memory Review"}</button>{!allDecided && <span>Decide each proposal before committing.</span>}</div>}
  </section>;
}

function MemoryReviewSettings({ progress, policy, profileId, invoke, prepare, readOnly }: { progress: MemoryReviewProgress | null; policy: AutoMemoryReviewPolicy | null; profileId?: string; invoke(command: HostCommand): Promise<unknown>; prepare(): void; readOnly: boolean }) {
  const [enabled, setEnabled] = useState(policy?.enabled ?? false);
  const [minEligible, setMinEligible] = useState(policy?.minEligibleExchangeCount ?? 20);
  const [maxInterval, setMaxInterval] = useState(policy?.maxIntervalDays ?? 30);
  const [maxTokens, setMaxTokens] = useState(policy?.maxInputTokensPerRun ?? 40_000);
  useEffect(() => {
    if (policy === null) return;
    setEnabled(policy.enabled);
    setMinEligible(policy.minEligibleExchangeCount);
    setMaxInterval(policy.maxIntervalDays);
    setMaxTokens(policy.maxInputTokensPerRun);
  }, [policy]);
  const savePolicy = () => {
    const selectedProfileId = policy?.profileId ?? profileId ?? "";
    if (selectedProfileId === "") return;
    void invoke(createCommand({ command: "memory_review.policy.set", payload: { policy: { enabled, profileId: selectedProfileId, minEligibleExchangeCount: minEligible, maxIntervalDays: maxInterval, maxInputTokensPerRun: maxTokens } } }));
  };
  return <section className="settings-section cognition-memory-review" aria-labelledby="memory-review-settings-title">
    <div className="settings-section-header"><div><span className="eyebrow">Cognitive review</span><h2 id="memory-review-settings-title">Memory Review</h2><p>Prepare a bounded Review Bundle from eligible learning sources. Active Memory changes only after explicit commit.</p></div><button className="compact-button" type="button" onClick={prepare} disabled={readOnly || progress?.status === "preparing"}><Moon size={15} /> Prepare Memory Review</button></div>
    {progress !== null && <MemoryReviewProgressPanel progress={progress} onCancel={() => void invoke(createCommand({ command: "memory_review.cancel", payload: {} }))} />}
    <dl><div><dt>Automatic preparation</dt><dd>{policy?.enabled ? "Enabled" : "Disabled"}</dd></div><div><dt>Minimum eligible exchanges</dt><dd>{policy?.minEligibleExchangeCount ?? "Not configured"}</dd></div><div><dt>Maximum interval</dt><dd>{policy === null ? "Not configured" : `${policy.maxIntervalDays} days`}</dd></div></dl>
    <details className="cognition-policy-details"><summary>Automatic preparation policy</summary><label><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} disabled={readOnly || (policy?.profileId ?? profileId) === undefined} /> Prepare automatically when signal thresholds are met</label><label>Minimum eligible exchanges<input type="number" min={0} value={minEligible} onChange={(event) => setMinEligible(Number(event.target.value))} disabled={readOnly} /></label><label>Maximum interval (days)<input type="number" min={1} value={maxInterval} onChange={(event) => setMaxInterval(Number(event.target.value))} disabled={readOnly} /></label><label>Input token budget<input type="number" min={1} value={maxTokens} onChange={(event) => setMaxTokens(Number(event.target.value))} disabled={readOnly} /></label><button type="button" onClick={savePolicy} disabled={readOnly || (policy?.profileId ?? profileId) === undefined}>Save policy</button></details>
  </section>;
}

function LongTermMemorySettings({ document, draft, maintenance, invoke, onChange, onRefresh, onSave, openFolder }: {
  document: LongTermMemoryDocument | null;
  draft: string;
  maintenance: MemoryMaintenanceState | null;
  invoke(command: HostCommand): Promise<unknown>;
  onChange(content: string): void;
  onRefresh(): void;
  onSave(): void;
  openFolder(): void;
}) {
  if (document === null) return <div className="memory-settings-loading">Loading Long-term Memory...</div>;
  const currentEntries = document.entries.filter((entry) => entry.status === "current");
  return <div className="long-term-memory-settings">
    <div className="memory-settings-heading"><div><span className="eyebrow">Personal cognition</span><h2>Long-term Memory</h2><p title={document.rootPath}>{document.rootPath}</p></div><div><button className="icon-button" type="button" title="Open memory folder" aria-label="Open memory folder" onClick={openFolder}><FolderOpen size={16} /></button><button className="icon-button" type="button" title="Refresh and re-index" aria-label="Refresh and re-index" onClick={onRefresh}><RefreshCw size={16} /></button></div></div>
    <div className="memory-summary"><span><strong>{currentEntries.length}</strong> current entries</span><span><strong>{currentEntries.filter((entry) => entry.recallPolicy === "explicit-only").length}</strong> explicit only</span><span><strong>{currentEntries.filter((entry) => entry.conflictState.startsWith("unresolved:")).length}</strong> unresolved views</span><span>Updated {new Date(document.updatedAt).toLocaleString()}</span></div>
    <div className="memory-file-list">{document.files.map((file) => <div key={file.kind}><div><strong>{file.name}</strong><span>{formatBytes(file.size)}</span></div><time dateTime={file.updatedAt}>{new Date(file.updatedAt).toLocaleString()}</time></div>)}</div>
    {document.warnings.length > 0 && <div className="context-warnings" role="status">{document.warnings.map((warning, index) => <span key={`${warning.code}-${index}`}>{warning.line ? `Line ${warning.line}: ` : ""}{warning.message}</span>)}</div>}
    <label className="memory-editor">Active memory<textarea aria-label="Long-term Memory" value={draft} onChange={(event) => onChange(event.target.value)} spellCheck="false" /></label>
    <div className="memory-editor-actions"><span>{document.sourceHash.slice(0, 12)}</span><button className="primary-button" type="button" onClick={onSave}>Save Memory</button></div>
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

type ConversationTurnProps = {
  items: ConversationItem[];
  configure(): void;
  chooseOutput(): void;
  retry(text: string, turnId: string): void;
  continueInterrupted(): void;
};

function ConversationTurn({ items, configure, chooseOutput, retry, continueInterrupted }: ConversationTurnProps) {
  const user = items.find((item): item is Extract<ConversationItem, { role: "user" }> => item.role === "user");
  const assistant = items.find((item): item is Extract<ConversationItem, { role: "assistant" }> => item.role === "assistant");
  const tools = items.filter((item): item is Extract<ConversationItem, { role: "tool" }> => item.role === "tool");
  const systemEvents = items.filter((item): item is Extract<ConversationItem, { role: "system" }> => item.role === "system");

  return <section className="conversation-turn" data-turn-id={items[0]?.turnId}>
    {user && <UserMessage item={user} />}
    {assistant
      ? <AssistantMessage item={assistant} tools={tools} systemEvents={systemEvents} configure={configure} chooseOutput={chooseOutput} retry={retry} continueInterrupted={continueInterrupted} />
      : <div className="turn-execution">{systemEvents.map((item) => <div className="system-event" key={item.id}>{item.text}</div>)}<ToolCallStack tools={tools} /></div>}
  </section>;
}

function UserMessage({ item }: { item: Extract<ConversationItem, { role: "user" }> }) {
  const submitted = parseConversationQuotedPrompt(item.text);
  return <article className="message user-message" data-conversation-message="true" data-turn-id={item.turnId} data-message-role="user"><div>
    {submitted.quotes.length > 0 && <div className="submitted-conversation-quotes">{submitted.quotes.map((quote, index) => <div className="submitted-conversation-quote" key={`${quote.turnId}-${quote.role}-${index}`}>
      <span>Conversation Quote · {quote.role} · Turn {quote.turnId.slice(0, 8)}</span>
      <p>{conversationQuotePreview(quote.text)}</p>
    </div>)}</div>}
    <div className="user-message-text">{submitted.text}</div>
  </div></article>;
}

function AssistantMessage({ item, tools, systemEvents, configure, chooseOutput, retry, continueInterrupted }: Omit<ConversationTurnProps, "items"> & {
  item: Extract<ConversationItem, { role: "assistant" }>;
  tools: Array<Extract<ConversationItem, { role: "tool" }>>;
  systemEvents: Array<Extract<ConversationItem, { role: "system" }>>;
}) {
  const hasExecutionTrace = item.thinking !== "" || tools.length > 0 || systemEvents.length > 0;
  return <article className={`message assistant-message ${item.status}`} data-conversation-message="true" data-turn-id={item.turnId} data-message-role="assistant">
    <div className="message-meta"><span>vc-agent</span>{item.profile && <span>{item.profile.provider} / {item.profile.model}</span>}</div>
    {hasExecutionTrace && <div className="turn-execution">
      {item.thinking && <details className="thinking-block"><summary><span>Thinking</span><span className="thinking-preview">{compactActivityPreview(item.thinking)}</span><ChevronDown size={14} /></summary><div>{item.thinking}</div></details>}
      {systemEvents.map((event) => <div className="system-event" key={event.id}>{event.text}</div>)}
      <ToolCallStack tools={tools} />
    </div>}
    <div className="assistant-output">
      {item.text && (item.status === "completed"
        ? <MarkdownMessage text={item.text} />
        : <div className="message-content streaming-markdown">{item.text}</div>)}
      {(item.status === "queued" || item.status === "streaming") && !item.text && <div className="streaming-label">{tools.some((tool) => tool.status === "started") ? "Running tool" : "Working"}</div>}
      {item.failure && <div className="provider-failure" role="alert"><strong>{item.failure.message}</strong><span>{item.failure.code}{item.failure.provider ? ` · ${item.failure.provider} / ${item.failure.model}` : ""}</span><div>{item.failure.code === "OUTPUT_LOCATION_NOT_CONFIGURED" && <button type="button" onClick={chooseOutput}>Choose output location</button>}<button type="button" onClick={() => item.retryText && retry(item.retryText, item.turnId)} disabled={!item.retryText}>Retry</button>{item.failure.code !== "OUTPUT_LOCATION_NOT_CONFIGURED" && <button type="button" onClick={configure}>Adjust profile</button>}</div></div>}
      {item.status === "interrupted" && <div className="interrupted-state"><strong>Interrupted</strong><span>The previous request will not resume automatically.</span><button type="button" onClick={continueInterrupted}>Continue</button></div>}
      {item.usage && <div className="usage-row">Input {formatExactTokenCount(item.usage.input)} · Reasoning {item.usage.reasoning === undefined ? "—" : formatExactTokenCount(item.usage.reasoning)} · Output {formatExactTokenCount(item.usage.output)}{item.prompt ? ` · prompt ${item.prompt.revisionId.slice(0, 8)} (${item.prompt.contributions.promptEstimatedTokens} prompt + ${item.prompt.contributions.toolSchemaEstimatedTokens} tools + ${item.prompt.contributions.contextEstimatedTokens} retained + ${item.prompt.contributions.outputReserveEstimatedTokens} reserve est.)` : ""}{item.prompt?.capabilitySurface === undefined ? "" : ` · surface ${item.prompt.capabilitySurface.visibleCapabilityIds.join(", ") || "none"} +${item.prompt.capabilitySurface.requestableCapabilityCount} on-demand`}{item.recalledStateEstimatedTokens === undefined ? "" : ` · recall ${item.recalledStateEstimatedTokens} est.`}{item.latencyMs === undefined ? "" : ` · ${item.latencyMs} ms`}</div>}
    </div>
  </article>;
}

function ToolCallStack({ tools }: { tools: Array<Extract<ConversationItem, { role: "tool" }>> }) {
  if (tools.length === 0) return null;
  if (tools.length === 1) return <ToolActivity tool={tools[0]!} />;
  const current = [...tools].reverse().find((tool) => tool.status === "started") ?? tools[tools.length - 1]!;
  return <details className={`tool-call-stack ${current.status}`}>
    <summary>
      <span className="tool-status-dot" aria-hidden="true" />
      <strong>{formatCapabilityName(current.capabilityId)}</strong>
      <span className="tool-call-preview">{compactActivityPreview(current.text)}</span>
      <span className="tool-call-count">{tools.length > 1 ? `${tools.length} calls` : formatToolStatus(current.status)}</span>
      <ChevronDown size={14} />
    </summary>
    <div className="tool-call-history">
      <div className="tool-call-history-heading"><span>Tool calls</span><span>{tools.length}</span></div>
      {tools.map((tool) => <ToolActivity key={tool.id} tool={tool} />)}
    </div>
  </details>;
}

function ToolActivity({ tool }: { tool: Extract<ConversationItem, { role: "tool" }> }) {
  return <details className={`tool-activity ${tool.status}`}><summary><span className="tool-status-dot" aria-hidden="true" /><strong>{formatCapabilityName(tool.capabilityId)}</strong><span>{formatToolStatus(tool.status)}</span><span className="sr-only">{tool.capabilityId} {tool.status}</span><ChevronDown size={13} /></summary><div className="tool-activity-content">{tool.runtime !== undefined && <small>{tool.runtime.sourceClass} · {tool.runtime.sourceId}@{tool.runtime.sourceRevision} · {tool.runtime.activationReason} · {tool.runtime.actionClass} · confirmation {tool.runtime.confirmationState}{tool.runtime.durationMs === undefined ? "" : ` · ${tool.runtime.durationMs}ms`}{tool.runtime.truncated ? " · truncated" : ""}</small>}{tool.capabilityId === "web_search" || tool.capabilityId === "web_fetch" ? <WebSourceResult text={tool.text} /> : <p>{tool.text}</p>}{tool.artifact && <a href={`#artifact-${tool.artifact.id}`} title={tool.artifact.destination}>{tool.artifact.mediaType} · {tool.artifact.destination}</a>}</div></details>;
}

function formatCapabilityName(capabilityId: string): string {
  return capabilityId.replaceAll("_", " ").replaceAll("-", " ");
}

function formatToolStatus(status: Extract<ConversationItem, { role: "tool" }>["status"]): string {
  if (status === "started") return "Running";
  if (status === "unknown_outcome") return "Unknown outcome";
  return status[0]!.toUpperCase() + status.slice(1);
}

function compactActivityPreview(text: string): string {
  return text.replace(/\s+/gu, " ").trim().slice(0, 96);
}

const MarkdownMessage = memo(function MarkdownMessage({ text }: { text: string }) {
  return <Suspense fallback={<div className="message-content streaming-markdown">{text}</div>}>
    <div className="message-content"><Markdown remarkPlugins={[remarkGfm]} skipHtml>{text}</Markdown></div>
  </Suspense>;
});

function ContextUsageIndicator({ usage }: { usage: ContextUsage | undefined }) {
  if (usage === undefined) return null;
  const used = usage.tokens === null ? "—" : formatTokenCount(usage.tokens);
  const total = formatTokenCount(usage.contextWindow);
  const percent = usage.percent === null ? "unknown" : `${usage.percent.toFixed(1)}%`;
  const exactUsed = usage.tokens === null ? "unknown" : formatExactTokenCount(usage.tokens);
  const exactTotal = formatExactTokenCount(usage.contextWindow);
  return <div className="context-usage" aria-label={`Session context ${exactUsed} of ${exactTotal} tokens, ${percent}`} title={`Current physical session context: ${exactUsed} / ${exactTotal} tokens (${percent})`}>
    <span>Context {used} / {total}</span>
    <span className="context-usage-track" aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(0, usage.percent ?? 0))}%` }} /></span>
  </div>;
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

function formatExactTokenCount(tokens: number): string {
  return Math.round(tokens).toLocaleString();
}

function isProviderUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

function academicCredentialLabel(source: AcademicCredentialSource): string {
  if (source === "openalex") return "OpenAlex API key";
  if (source === "github") return "GitHub token";
  return "Hugging Face token";
}

function academicCredentialDescription(source: AcademicCredentialSource): string {
  if (source === "openalex") return "Required for OpenAlex paper, author, institution, and citation queries.";
  if (source === "github") return "Optional but recommended for higher public repository API limits.";
  return "Optional for public Hub assets; enables authenticated Hub requests when required.";
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

function groupConversationItems(items: ConversationItem[]): Array<{ turnId: string; items: ConversationItem[] }> {
  const groups = new Map<string, ConversationItem[]>();
  for (const item of items) {
    const group = groups.get(item.turnId);
    if (group === undefined) groups.set(item.turnId, [item]);
    else group.push(item);
  }
  return [...groups].map(([turnId, turnItems]) => ({ turnId, items: turnItems }));
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
      thinking: "",
      status: turn.status === "active" || turn.status === "submitted" ? "interrupted" : turn.status,
      ...(turn.profile === undefined ? {} : { profile: turn.profile }),
      ...(turn.usage === undefined ? {} : { usage: turn.usage }),
      ...(turn.citations === undefined ? {} : { citations: turn.citations }),
      ...(turn.latencyMs === undefined ? {} : { latencyMs: turn.latencyMs }),
      ...(turn.recalledStateEstimatedTokens === undefined ? {} : { recalledStateEstimatedTokens: turn.recalledStateEstimatedTokens }),
      ...(turn.prompt === undefined ? {} : { prompt: { revisionId: turn.prompt.revisionId, contributions: turn.prompt.contributions, ...(turn.prompt.capabilitySurface === undefined ? {} : { capabilitySurface: turn.prompt.capabilitySurface }) } }),
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
          ...(activity.runtime === undefined ? {} : { runtime: activity.runtime }),
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
    ...(payload.runtime === undefined ? {} : { runtime: payload.runtime }),
    ...(payload.artifact === undefined ? {} : { artifact: payload.artifact })
  };
  const exists = items.some((item) => item.id === tool.id);
  return { ...current, [payload.threadId]: exists ? items.map((item) => item.id === tool.id ? tool : item) : [...items, tool] };
}

function appendTurn(current: Record<string, ConversationItem[]>, threadId: string, turnId: string, text: string, profile: ModelProfile, prompt: Extract<ConversationItem, { role: "assistant" }>['prompt']) {
  return { ...current, [threadId]: [...(current[threadId] ?? []), { id: `${turnId}:user`, turnId, role: "user", text }, { id: `${turnId}:assistant`, turnId, role: "assistant", text: "", thinking: "", status: "queued", profile, retryText: text, prompt }] } satisfies Record<string, ConversationItem[]>;
}

function updateAssistant(current: Record<string, ConversationItem[]>, threadId: string, turnId: string, update: (item: Extract<ConversationItem, { role: "assistant" }>) => Extract<ConversationItem, { role: "assistant" }>) {
  return { ...current, [threadId]: (current[threadId] ?? []).map((item) => item.role === "assistant" && item.turnId === turnId ? update(item) : item) };
}

function failTurn(current: Record<string, ConversationItem[]>, payload: Extract<HostEvent, { event: "turn.failed" }>["payload"]) {
  const existing = (current[payload.threadId] ?? []).some((item) => item.turnId === payload.turnId);
  if (!existing) {
    return { ...current, [payload.threadId]: [...(current[payload.threadId] ?? []), { id: `${payload.turnId}:user`, turnId: payload.turnId, role: "user", text: payload.text }, { id: `${payload.turnId}:assistant`, turnId: payload.turnId, role: "assistant", text: "", thinking: "", status: "failed", failure: payload.failure, ...(payload.profile === undefined ? {} : { profile: payload.profile }), retryText: payload.text }] } satisfies Record<string, ConversationItem[]>;
  }
  return updateAssistant(current, payload.threadId, payload.turnId, (item) => ({ ...item, status: "failed", failure: payload.failure, retryText: payload.text }));
}

function localDiagnostic(message: string): Extract<HostEvent, { event: "diagnostic.raised" }> {
  return { schemaVersion: 1, eventId: crypto.randomUUID(), correlationId: crypto.randomUUID(), sequence: 0, actor: { actorType: "host", actorId: "renderer-validation" }, provenance: { producerType: "host", producerId: "renderer-validation" }, occurredAt: new Date().toISOString(), event: "diagnostic.raised", payload: { code: "INVALID_COMMAND", message, recoverable: true } };
}

function readConversationSelection(threadId: string): ConversationSelection | null {
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const anchor = closestConversationMessage(selection.anchorNode);
  const focus = closestConversationMessage(selection.focusNode);
  if (anchor === null || anchor !== focus) return null;
  const anchorContent = closestMessageContent(selection.anchorNode);
  const focusContent = closestMessageContent(selection.focusNode);
  if (anchorContent === null || focusContent === null || !anchor.contains(anchorContent) || !anchor.contains(focusContent)) return null;
  const turnId = anchor.dataset.turnId;
  const role = anchor.dataset.messageRole;
  if (turnId === undefined || (role !== "user" && role !== "assistant")) return null;
  const selectedText = selection.toString().replaceAll("\r\n", "\n").trim();
  if (selectedText.length === 0) return null;
  const text = selectedText.length > MAX_CONVERSATION_QUOTE_LENGTH
    ? `${selectedText.slice(0, MAX_CONVERSATION_QUOTE_LENGTH - 1)}…`
    : selectedText;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  const below = rect.bottom + 8;
  const top = below + 36 <= window.innerHeight ? below : Math.max(8, rect.top - 38);
  const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - 132));
  return { threadId, turnId, role, text, top, left };
}

function closestConversationMessage(node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : node?.parentElement;
  return element?.closest<HTMLElement>("[data-conversation-message='true']") ?? null;
}

function closestMessageContent(node: Node | null): Element | null {
  const element = node instanceof Element ? node : node?.parentElement;
  return element?.closest(".message-content, .user-message > div") ?? null;
}

function serializeConversationQuotes(text: string, quotes: ConversationQuote[]): string {
  if (quotes.length === 0) return text;
  const serialized = quotes.map((quote) => [
    `<conversation_quote source_turn="${escapeConversationQuoteValue(quote.turnId)}" role="${quote.role}">`,
    escapeConversationQuoteValue(quote.text),
    "</conversation_quote>"
  ].join("\n")).join("\n");
  return `<conversation_quotes>\n${serialized}\n</conversation_quotes>\n\n${text}`;
}

function parseConversationQuotedPrompt(value: string): { quotes: Array<Pick<ConversationQuote, "turnId" | "role" | "text">>; text: string } {
  const wrapper = /^<conversation_quotes>\n([\s\S]*?)\n<\/conversation_quotes>\n\n([\s\S]*)$/u.exec(value);
  if (wrapper === null) return { quotes: [], text: value };
  const quoteBlock = wrapper[1]!;
  const quotePattern = /<conversation_quote source_turn="([^"]+)" role="(user|assistant)">\n([\s\S]*?)\n<\/conversation_quote>/gu;
  const matches = [...quoteBlock.matchAll(quotePattern)];
  const unparsed = quoteBlock.replace(quotePattern, "").trim();
  if (matches.length === 0 || unparsed.length > 0) return { quotes: [], text: value };
  return {
    quotes: matches.map((match) => ({
      turnId: unescapeConversationQuoteValue(match[1]!),
      role: match[2] as "user" | "assistant",
      text: unescapeConversationQuoteValue(match[3]!)
    })),
    text: wrapper[2]!
  };
}

function escapeConversationQuoteValue(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&apos;");
}

function unescapeConversationQuoteValue(value: string): string {
  return value.replaceAll("&apos;", "'").replaceAll("&quot;", "\"").replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
}

function conversationQuotePreview(value: string): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length > 180 ? `${compact.slice(0, 179)}…` : compact;
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
