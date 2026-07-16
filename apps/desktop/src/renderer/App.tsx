import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  createBootstrapCommand,
  createCommand,
  hostEventSchema,
  type BootstrapState,
  type HostCommand,
  type HostEvent,
  type MaterialInventoryItem,
  type ModelProfile,
  type Project,
  type PromptContribution,
  type ProviderFailure,
  type SystemPromptRevision,
  type TrajectoryProfile,
  type TokenUsage,
  type Thread
} from "@vc-agent/contracts";
import {
  ChevronDown,
  CircleStop,
  Folder,
  KeyRound,
  MessageSquare,
  PanelRight,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  SlidersHorizontal
} from "lucide-react";

type View = "workspace" | "settings";
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

export function App() {
  const [view, setView] = useState<View>("workspace");
  const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null);
  const [diagnostic, setDiagnostic] = useState<HostEvent | null>(null);
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [promptRevisions, setPromptRevisions] = useState<SystemPromptRevision[]>([]);
  const [activePromptRevisionId, setActivePromptRevisionId] = useState<string | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
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

  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  const activeProfile = profiles.find((profile) => profile.id === activeThread?.activeProfileId);
  const items = activeThreadId === null ? [] : conversations[activeThreadId] ?? [];
  const hasActiveTurn = items.some(
    (item) => item.role === "assistant" && (item.status === "queued" || item.status === "streaming")
  );
  const activeTurn = items.find((item) => item.role === "assistant" && (item.status === "queued" || item.status === "streaming"));

  const applyEvent = useCallback((event: HostEvent) => {
    switch (event.event) {
      case "app.bootstrap.completed": setBootstrap(event.payload); break;
      case "access.mode.changed": setBootstrap((current) => current === null ? current : { ...current, accessMode: event.payload.mode }); break;
      case "profiles.listed": setProfiles(event.payload.profiles); break;
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
      case "material.parse.refresh.choice.required": setParseRefreshChoice(event); break;
      case "material.parse.refresh.choice.resolved": setParseRefreshChoice(null); break;
      case "profile.created":
        setProfiles((current) => [...current.filter((item) => item.id !== event.payload.profile.id), event.payload.profile]);
        setProfileFormOpen(false);
        break;
      case "threads.listed": setThreads(event.payload.threads); break;
      case "thread.trajectory.loaded":
        setConversations((current) => ({ ...current, [event.payload.threadId]: projectTrajectory(event.payload.turns, event.payload.activities) }));
        break;
      case "thread.created":
        setThreads((current) => [...current, event.payload.thread]);
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
        setActiveThreadId(event.payload.thread.id);
        setView("workspace");
        if (event.payload.action === "start_new_thread") {
          setConversations((current) => ({ ...current, [event.payload.thread.id]: [] }));
        }
        break;
      case "thread.output.location.selected":
        setThreads((current) => current.map((item) => item.id === event.payload.thread.id ? event.payload.thread : item));
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
        setConversations((current) => updateAssistant(current, event.payload.threadId, event.payload.turnId, (item) => ({ ...item, text: event.payload.message, status: "completed", profile: event.payload.profile, usage: event.payload.usage })));
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
      return;
    }
    applyEvent(parsed.data);
  }, [applyEvent]);

  useEffect(() => {
    const unsubscribe = window.vcAgent.onEvent((rawEvent) => {
      const parsed = hostEventSchema.safeParse(rawEvent);
      if (parsed.success) applyEvent(parsed.data);
    });
    void invoke(createBootstrapCommand());
    void invoke(createCommand({ command: "profile.list" }));
    void invoke(createCommand({ command: "prompt.revision.list" }));
    void invoke(createCommand({ command: "project.list" }));
    void invoke(createCommand({ command: "thread.list" }));
    return unsubscribe;
  }, [applyEvent, invoke]);

  useEffect(() => {
    if (activeThread?.scope === "project") void invoke(createCommand({ command: "project.material.list", payload: { projectId: activeThread.projectId } }));
  }, [activeThread?.id, activeThread?.scope === "project" ? activeThread.projectId : null, invoke]);

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
    if (activeThreadId === null || profileId.length === 0) return;
    void invoke(createCommand({ command: "thread.profile.select", payload: { threadId: activeThreadId, profileId } }));
  };

  const selectThread = (threadId: string) => {
    setActiveThreadId(threadId);
    setView("workspace");
    void invoke(createCommand({ command: "thread.trajectory.load", payload: { threadId } }));
  };

  const submit = (text = prompt, retryOfTurnId?: string) => {
    if (activeThreadId === null || text.trim().length === 0 || hasActiveTurn) return;
    void invoke(createCommand({
      command: "turn.submit",
      payload: { threadId: activeThreadId, text: text.trim(), ...(retryOfTurnId === undefined ? {} : { retryOfTurnId }) }
    }));
  };

  const stop = () => {
    if (activeThreadId === null || activeTurn?.role !== "assistant") return;
    void invoke(createCommand({ command: "turn.stop", payload: { threadId: activeThreadId, turnId: activeTurn.turnId } }));
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

  return (
    <div className="app-shell">
      <aside className="left-rail" aria-label="Navigation">
        <div className="brand-row">
          <div className="brand-mark">VC</div><span>vc-agent</span>
          <button className="icon-button" type="button" title="Search" aria-label="Search" disabled><Search size={17} /></button>
        </div>
        <nav className="navigation-groups">
          <section>
            <div className="section-label">
              <MessageSquare size={15} /><span>Unscoped Threads</span>
              <button className="section-action" type="button" title="New thread" aria-label="New thread" onClick={createThread}><Plus size={15} /></button>
            </div>
            {threads.filter((thread) => thread.scope === "unscoped").length === 0 ? <p className="empty-list">No threads</p> : threads.filter((thread) => thread.scope === "unscoped").map((thread) => (
              <button key={thread.id} className={`thread-row ${thread.id === activeThreadId ? "active" : ""}`} type="button" onClick={() => selectThread(thread.id)}>
                <MessageSquare size={14} /><span>{thread.title}</span>
              </button>
            ))}
          </section>
          <section>
            <div className="section-label"><Folder size={15} /><span>Projects</span><button className="section-action" type="button" title="Open project" aria-label="Open project" onClick={openProject}><Plus size={15} /></button></div>
            {projects.length === 0 ? <p className="empty-list">No projects</p> : projects.map((project) => <div className="project-group" key={project.id}>
              <div className="project-row"><span title={project.path}>{project.displayName}</span><button className="section-action" type="button" title="New project thread" aria-label={`New thread in ${project.displayName}`} onClick={() => createProjectThread(project.id)}><Plus size={14} /></button></div>
              {threads.filter((thread) => thread.scope === "project" && thread.projectId === project.id).map((thread) => <button key={thread.id} className={`thread-row project-thread ${thread.id === activeThreadId ? "active" : ""}`} type="button" onClick={() => selectThread(thread.id)}><MessageSquare size={14} /><span>{thread.title}</span></button>)}
            </div>)}
          </section>
        </nav>
        <button className={`settings-button ${view === "settings" ? "active" : ""}`} type="button" onClick={() => setView(view === "settings" ? "workspace" : "settings")}>
          <Settings size={17} /><span>Settings</span>
        </button>
      </aside>

      <main className="center-pane">
        <DiagnosticBanner event={diagnostic} />
        {view === "settings" ? (
          <SettingsView bootstrap={bootstrap} profiles={profiles} promptRevisions={promptRevisions} activePromptRevisionId={activePromptRevisionId} formOpen={profileFormOpen} setFormOpen={setProfileFormOpen} invoke={invoke} />
        ) : activeThread === undefined ? (
          <div className="empty-workspace" data-testid="empty-workspace"><div className="empty-icon"><MessageSquare size={22} /></div><h1>No active thread</h1><p>Create or select a thread from the navigation.</p></div>
        ) : (
          <section className="conversation" aria-label="Conversation">
            <header className="conversation-header"><div><span className="eyebrow">{activeThread.scope === "project" ? projects.find((project) => project.id === activeThread.projectId)?.displayName ?? "Project Thread" : "Unscoped Thread"}</span><h1>{activeThread.title}</h1></div><span className="header-model">{activeProfile === undefined ? "No profile" : `${activeProfile.provider} / ${activeProfile.model}`}</span></header>
            <div className="message-list">
              {items.length === 0 ? <div className="thread-empty"><MessageSquare size={20} /><span>Ready for a new conversation</span></div> : items.map((item) => (
                <MessageItem key={item.id} item={item} configure={() => setView("settings")} chooseOutput={chooseOutputLocation} retry={(text, turnId) => submit(text, turnId)} continueInterrupted={() => setPrompt("Continue from the interrupted response.")} />
              ))}
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

        {view === "workspace" && activeThread !== undefined && (
          <form className="composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
            <textarea aria-label="Message" placeholder="Ask vc-agent" value={prompt} onChange={(event) => setPrompt(event.target.value)} disabled={hasActiveTurn} />
            <div className="composer-footer">
              <select aria-label="Active Model Profile" value={activeThread.activeProfileId ?? ""} onChange={(event) => selectProfile(event.target.value)} disabled={hasActiveTurn || profiles.length === 0}>
                <option value="">No profile</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
              </select>
              <span className="output-location" title={activeThread.scope === "unscoped" ? activeThread.outputLocation : projects.find((project) => project.id === activeThread.projectId)?.path}>{activeThread.scope === "unscoped" ? activeThread.outputLocation ?? "No output location" : "Project scoped"}</span>
              {bootstrap?.accessMode === "full" && <span className="full-access-indicator">Full access</span>}
              {hasActiveTurn ? <button className="stop-button" type="button" title="Stop" aria-label="Stop" onClick={stop}><CircleStop size={16} /></button> : <button className="send-button" type="submit" title="Send" aria-label="Send" disabled={prompt.trim().length === 0}><Send size={16} /></button>}
            </div>
          </form>
        )}
      </main>

      <aside className="right-panel" aria-label="Project state">
        <div className="panel-tabs" role="tablist" aria-label="Project state views"><button type="button" className="active" role="tab" aria-selected="true">Overview</button><button type="button" role="tab" disabled>Outputs</button><button type="button" role="tab" disabled>Context</button><button type="button" role="tab" disabled>Memory</button></div>
        {activeThread?.scope === "project" ? <div className="material-inventory"><div className="inventory-heading"><h2>{projects.find((project) => project.id === activeThread.projectId)?.displayName ?? "Project"}</h2><button className="section-action" type="button" title="Refresh materials" aria-label="Refresh materials" onClick={() => void invoke(createCommand({ command: "project.material.refresh", payload: { projectId: activeThread.projectId } }))}><RefreshCw size={14} /></button></div><p>Material metadata only. Content loads on demand.</p>{(materialsByProject[activeThread.projectId] ?? []).filter((material) => material.availability === "active").length === 0 ? <span className="empty-list">No supported materials</span> : (materialsByProject[activeThread.projectId] ?? []).filter((material) => material.availability === "active").map((material) => <div className="material-row" key={material.id}><div><strong title={material.relativePath}>{material.relativePath}</strong><span>{material.extension} · {formatBytes(material.size)} · {material.parseStatus}</span></div>{material.parseStatus === "stale" && <button type="button" onClick={() => void invoke(createCommand({ command: "material.need", payload: { materialId: material.id } }))}>Refresh parse</button>}</div>)}</div> : <div className="panel-empty"><PanelRight size={20} /><h2>No project selected</h2><p>Unscoped threads have no project state.</p></div>}
        <div className="status-strip"><span><span className="status-dot" /> Host ready</span><span>Schema {bootstrap?.stateSchemaVersion ?? "-"}</span></div>
      </aside>
    </div>
  );
}

function SettingsView({ bootstrap, profiles, promptRevisions, activePromptRevisionId, formOpen, setFormOpen, invoke }: {
  bootstrap: BootstrapState | null;
  profiles: ModelProfile[];
  promptRevisions: SystemPromptRevision[];
  activePromptRevisionId: string | null;
  formOpen: boolean;
  setFormOpen(value: boolean): void;
  invoke(command: HostCommand): Promise<void>;
}) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState<ModelProfile["thinkingLevel"]>("off");
  const valid = name.trim() && provider.trim() && model.trim() && apiKey;
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    void invoke(createCommand({ command: "profile.create", payload: { name, provider, model, apiKey, thinkingLevel } })).then(() => {
      setName(""); setProvider(""); setModel(""); setApiKey(""); setThinkingLevel("off");
    });
  };
  return (
    <section className="settings-view" aria-labelledby="settings-title">
      <header><div><span className="eyebrow">Application</span><h1 id="settings-title">Settings</h1></div><SlidersHorizontal size={20} /></header>
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
        <div className="profile-list">{profiles.length === 0 ? <p className="empty-setting">No model profiles</p> : profiles.map((profile) => <div className="profile-row" key={profile.id}><div><strong>{profile.name}</strong><span>{profile.provider} / {profile.model}</span></div><span>{profile.thinkingLevel}</span></div>)}</div>
      </div>
      <PromptSettings revisions={promptRevisions} activeRevisionId={activePromptRevisionId} invoke={invoke} />
      <div className="settings-section"><h2>Access Mode</h2><div className="access-mode-control" role="group" aria-label="Access Mode"><button type="button" className={bootstrap?.accessMode === "standard" ? "active" : ""} onClick={() => void invoke(createCommand({ command: "access.mode.set", payload: { mode: "standard" } }))}>Standard</button><button type="button" className={bootstrap?.accessMode === "full" ? "active full" : ""} onClick={() => void invoke(createCommand({ command: "access.mode.set", payload: { mode: "full" } }))}>Full Access</button></div></div>
      <div className="settings-section"><h2>Local state</h2><dl><div><dt>Application version</dt><dd>{bootstrap?.applicationVersion ?? "Loading"}</dd></div><div><dt>State schema</dt><dd>{bootstrap?.stateSchemaVersion ?? "Loading"}</dd></div><div><dt>Projects</dt><dd>{bootstrap?.entityCounts.projects ?? 0}</dd></div><div><dt>Threads</dt><dd>{bootstrap?.entityCounts.threads ?? 0}</dd></div></dl></div>
      <div className="settings-section"><h2>Runtime</h2><dl><div><dt>Agent workers</dt><dd>{bootstrap?.runtimeActivity.agentWorkersStarted ?? 0}</dd></div><div><dt>Pi sessions</dt><dd>{bootstrap?.runtimeActivity.piSessionsStarted ?? 0}</dd></div><div><dt>Provider requests</dt><dd>{bootstrap?.runtimeActivity.providerRequests ?? 0}</dd></div></dl></div>
    </section>
  );
}

function PromptSettings({ revisions, activeRevisionId, invoke }: {
  revisions: SystemPromptRevision[];
  activeRevisionId: string | null;
  invoke(command: HostCommand): Promise<void>;
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
  if (item.role === "tool") return <div className={`tool-activity ${item.status}`}><div><strong>{item.capabilityId}</strong><span>{item.status.replace("_", " ")}</span></div><p>{item.text}</p>{item.artifact && <a href={`#artifact-${item.artifact.id}`} title={item.artifact.destination}>{item.artifact.mediaType} · {item.artifact.destination}</a>}</div>;
  return <article className={`message assistant-message ${item.status}`}>
    <div className="message-meta"><span>vc-agent</span>{item.profile && <span>{item.profile.provider} / {item.profile.model}</span>}</div>
    {item.text && <div className="message-content">{item.text}</div>}
    {(item.status === "queued" || item.status === "streaming") && !item.text && <div className="streaming-label">Working</div>}
    {item.failure && <div className="provider-failure" role="alert"><strong>{item.failure.message}</strong><span>{item.failure.code}{item.failure.provider ? ` · ${item.failure.provider} / ${item.failure.model}` : ""}</span><div>{item.failure.code === "OUTPUT_LOCATION_NOT_CONFIGURED" && <button type="button" onClick={chooseOutput}>Choose output location</button>}<button type="button" onClick={() => item.retryText && retry(item.retryText, item.turnId)} disabled={!item.retryText}>Retry</button>{item.failure.code !== "OUTPUT_LOCATION_NOT_CONFIGURED" && <button type="button" onClick={configure}>Adjust profile</button>}</div></div>}
    {item.status === "interrupted" && <div className="interrupted-state"><strong>Interrupted</strong><span>The previous request will not resume automatically.</span><button type="button" onClick={continueInterrupted}>Continue</button></div>}
    {item.usage && <div className="usage-row">Completed · {item.usage.input} input · {item.usage.output} output tokens{item.prompt ? ` · prompt ${item.prompt.revisionId.slice(0, 8)} (${item.prompt.contributions.promptEstimatedTokens} est.)` : ""}</div>}
  </article>;
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
