import { useEffect, useState } from "react";
import {
  createBootstrapCommand,
  hostEventSchema,
  type BootstrapState,
  type HostEvent
} from "@vc-agent/contracts";
import {
  Archive,
  ChevronDown,
  FileText,
  Folder,
  MessageSquare,
  PanelRight,
  Search,
  Settings,
  SlidersHorizontal
} from "lucide-react";

type View = "workspace" | "settings";

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

  useEffect(() => {
    const unsubscribe = window.vcAgent.onEvent((rawEvent) => {
      const parsed = hostEventSchema.safeParse(rawEvent);
      if (parsed.success && parsed.data.event === "diagnostic.raised") {
        setDiagnostic(parsed.data);
      }
    });

    window.vcAgent.invoke(createBootstrapCommand()).then((rawEvent) => {
      const parsed = hostEventSchema.safeParse(rawEvent);
      if (!parsed.success) {
        setDiagnostic({
          schemaVersion: 1,
          eventId: crypto.randomUUID(),
          correlationId: crypto.randomUUID(),
          sequence: 0,
          actor: { actorType: "host", actorId: "renderer-validation" },
          provenance: { producerType: "host", producerId: "renderer-validation" },
          occurredAt: new Date().toISOString(),
          event: "diagnostic.raised",
          payload: { code: "INVALID_COMMAND", message: "The Host returned an invalid event envelope.", recoverable: true }
        });
      } else if (parsed.data.event === "app.bootstrap.completed") {
        setBootstrap(parsed.data.payload);
      } else {
        setDiagnostic(parsed.data);
      }
    });

    return unsubscribe;
  }, []);

  return (
    <div className="app-shell">
      <aside className="left-rail" aria-label="Navigation">
        <div className="brand-row">
          <div className="brand-mark">VC</div>
          <span>vc-agent</span>
          <button className="icon-button" type="button" title="Search" aria-label="Search" disabled>
            <Search size={17} />
          </button>
        </div>

        <nav className="navigation-groups">
          <section>
            <div className="section-label">
              <MessageSquare size={15} />
              <span>Unscoped Threads</span>
            </div>
            <p className="empty-list">No threads</p>
          </section>
          <section>
            <div className="section-label">
              <Folder size={15} />
              <span>Projects</span>
              <ChevronDown size={14} />
            </div>
            <p className="empty-list">No projects</p>
          </section>
        </nav>

        <button
          className={`settings-button ${view === "settings" ? "active" : ""}`}
          type="button"
          onClick={() => setView(view === "settings" ? "workspace" : "settings")}
        >
          <Settings size={17} />
          <span>Settings</span>
        </button>
      </aside>

      <main className="center-pane">
        <DiagnosticBanner event={diagnostic} />
        {view === "workspace" ? (
          <div className="empty-workspace" data-testid="empty-workspace">
            <div className="empty-icon"><MessageSquare size={22} /></div>
            <h1>No active thread</h1>
            <p>Select a thread or project from the navigation.</p>
          </div>
        ) : (
          <section className="settings-view" aria-labelledby="settings-title">
            <header>
              <div>
                <span className="eyebrow">Application</span>
                <h1 id="settings-title">Settings</h1>
              </div>
              <SlidersHorizontal size={20} />
            </header>
            <div className="settings-section">
              <h2>Local state</h2>
              <dl>
                <div><dt>Application version</dt><dd>{bootstrap?.applicationVersion ?? "Loading"}</dd></div>
                <div><dt>State schema</dt><dd>{bootstrap?.stateSchemaVersion ?? "Loading"}</dd></div>
                <div><dt>Projects</dt><dd>{bootstrap?.entityCounts.projects ?? 0}</dd></div>
                <div><dt>Threads</dt><dd>{bootstrap?.entityCounts.threads ?? 0}</dd></div>
              </dl>
            </div>
            <div className="settings-section">
              <h2>Runtime</h2>
              <dl>
                <div><dt>Agent workers</dt><dd>{bootstrap?.runtimeActivity.agentWorkersStarted ?? 0}</dd></div>
                <div><dt>Pi sessions</dt><dd>{bootstrap?.runtimeActivity.piSessionsStarted ?? 0}</dd></div>
                <div><dt>Provider requests</dt><dd>{bootstrap?.runtimeActivity.providerRequests ?? 0}</dd></div>
              </dl>
            </div>
          </section>
        )}

        {view === "workspace" && (
          <div className="composer-shell" aria-label="Prompt composer unavailable without a thread">
            <button className="profile-button" type="button" disabled>
              No profile <ChevronDown size={14} />
            </button>
            <span>Select a thread to compose</span>
          </div>
        )}
      </main>

      <aside className="right-panel" aria-label="Project state">
        <div className="panel-tabs" role="tablist" aria-label="Project state views">
          <button type="button" className="active" role="tab" aria-selected="true">Overview</button>
          <button type="button" role="tab" aria-selected="false" disabled>Outputs</button>
          <button type="button" role="tab" aria-selected="false" disabled>Context</button>
          <button type="button" role="tab" aria-selected="false" disabled>Memory</button>
        </div>
        <div className="panel-empty">
          <PanelRight size={20} />
          <h2>No project selected</h2>
          <p>Project state will appear here.</p>
        </div>
        <div className="status-strip">
          <span><span className="status-dot" /> Host ready</span>
          <span>Schema {bootstrap?.stateSchemaVersion ?? "-"}</span>
        </div>
      </aside>
    </div>
  );
}
