import { FolderOpen, RefreshCw, Upload } from "lucide-react";
import type {
  PiResourceDiagnostic,
  PiResourcesSettingsActions,
  PiResourcesSettingsProps,
  PiResourceStatus
} from "@vc-agent/contracts";

/**
 * Settings for Pi-native Extensions, MCP, and the isolated VC Agent Skills
 * directory.  This is intentionally a presentational view: the callbacks are
 * small user intents, not the retired Host integration command union.
 */
export function PiResourcesSettings({ state, actions, disabled = false }: PiResourcesSettingsProps) {
  const run = (action: () => void | Promise<void>) => {
    // Promise.resolve().then() also catches synchronous callback failures.  IPC
    // adapters can surface their own error state on the next state update.
    void Promise.resolve().then(action).catch(() => undefined);
  };

  return (
    <section className="settings-section pi-resources-settings" data-testid="pi-resources-settings">
      <div className="settings-section-header">
        <div>
          <span className="eyebrow">Pi-native resources</span>
          <h2>Extensions, MCP, and Skills</h2>
          <p>
            Files in the documented sources are loaded by Pi at the next safe session boundary. Reload observes the
            sources; it does not execute dormant resources from this settings view.
          </p>
        </div>
        <button
          className="compact-button"
          type="button"
          onClick={() => run(actions.onReload)}
          disabled={disabled}
          data-testid="pi-resources-reload"
        >
          <RefreshCw size={15} /> Reload
        </button>
      </div>

      {state.extensions.projectResourcesTrusted !== undefined && (
        <label className="checkbox-setting pi-project-resource-trust">
          <input
            key={`${state.generation}:${state.extensions.projectResourcesTrusted ? "trusted" : "untrusted"}`}
            type="checkbox"
            defaultChecked={state.extensions.projectResourcesTrusted}
            onChange={(event) => {
              if (actions.onSetProjectResourcesTrusted !== undefined) {
                run(() => actions.onSetProjectResourcesTrusted?.(event.target.checked));
              }
            }}
            disabled={disabled || actions.onSetProjectResourcesTrusted === undefined}
            data-testid="pi-project-resources-trusted"
          />
          <span>
            Trust project-local Pi resources
            <small>When enabled, project-local Extensions and MCP configuration may participate at the next session boundary.</small>
          </span>
        </label>
      )}

      <div className="pi-resource-list">
        <PiResourceCard
          testId="pi-extensions-settings"
          title="Extensions"
          description="Install a trusted Pi Extension by placing it in the VC Agent Extension directory."
          pathLabel="Extension directory"
          path={state.extensions.directoryPath}
          status={state.extensions.status}
          loadedSummary={`${state.extensions.loadedCount} loaded`}
          trustDisclosure={state.extensions.trustDisclosure}
          diagnostics={state.extensions.diagnostics}
          disabled={disabled}
          actions={[
            {
              label: "Open Folder",
              icon: <FolderOpen size={14} />,
              onClick: actions.onOpenExtensionsFolder,
              testId: "pi-extensions-open-folder"
            },
            { label: "Reload", icon: <RefreshCw size={14} />, onClick: actions.onReload, testId: "pi-extensions-reload" }
          ]}
          run={run}
        />

        <PiResourceCard
          testId="pi-mcp-settings"
          title="MCP"
          description="Configure MCP servers in the app-owned mcp.json. The adapter exposes its native proxy tool."
          pathLabel="Configuration"
          path={state.mcp.configPath}
          status={state.mcp.status}
          loadedSummary={`${state.mcp.serverCount} server${state.mcp.serverCount === 1 ? "" : "s"} configured · ${state.mcp.connectedServerCount} connected`}
          trustDisclosure={state.mcp.trustDisclosure}
          diagnostics={state.mcp.diagnostics}
          disabled={disabled}
          actions={[
            {
              label: "Open/Edit mcp.json",
              icon: <FolderOpen size={14} />,
              onClick: actions.onOpenMcpConfig,
              testId: "pi-mcp-open-config"
            },
            { label: "Reload", icon: <RefreshCw size={14} />, onClick: actions.onReload, testId: "pi-mcp-reload" }
          ]}
          run={run}
        />

        <PiResourceCard
          testId="pi-skills-settings"
          title="Skills"
          description="Only the dedicated VC Agent Skills directory is supplied to Pi's progressive-disclosure loader."
          pathLabel="Dedicated directory"
          path={state.skills.directoryPath}
          status={state.skills.status}
          loadedSummary={`${state.skills.loadedCount} available`}
          trustDisclosure={state.skills.trustDisclosure}
          diagnostics={state.skills.diagnostics}
          isolationDisclosure={state.skills.sourceIsolationDisclosure}
          disabled={disabled}
          actions={[
            {
              label: "Open dedicated folder",
              icon: <FolderOpen size={14} />,
              onClick: actions.onOpenSkillsFolder,
              testId: "pi-skills-open-folder"
            },
            {
              label: "Import Copy",
              icon: <Upload size={14} />,
              onClick: actions.onImportSkill,
              testId: "pi-skills-import-copy"
            },
            { label: "Reload", icon: <RefreshCw size={14} />, onClick: actions.onReload, testId: "pi-skills-reload" }
          ]}
          run={run}
        />
      </div>

      <PiDiagnostics diagnostics={state.diagnostics} />
      {state.reloadPending && <p className="integration-runtime-status" role="status">Reload queued until the active Turn closes.</p>}
    </section>
  );
}

interface PiResourceCardProps {
  testId: string;
  title: string;
  description: string;
  pathLabel: string;
  path: string;
  status: PiResourceStatus;
  loadedSummary: string;
  trustDisclosure: string;
  isolationDisclosure?: string;
  diagnostics: readonly PiResourceDiagnostic[];
  actions: readonly PiResourceAction[];
  disabled: boolean;
  run: (action: () => void | Promise<void>) => void;
}

interface PiResourceAction {
  label: string;
  icon: React.ReactNode;
  onClick: () => void | Promise<void>;
  testId: string;
}

function PiResourceCard({
  testId,
  title,
  description,
  pathLabel,
  path,
  status,
  loadedSummary,
  trustDisclosure,
  isolationDisclosure,
  diagnostics,
  actions,
  disabled,
  run
}: PiResourceCardProps) {
  return (
    <article className="integration-card pi-resource-card" data-testid={testId}>
      <header className="pi-resource-card-header">
        <div className="pi-resource-card-title">
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        <span className={`doctor-status ${status}`} role="status">{status}</span>
      </header>
      <div className="pi-resource-card-details">
        <div className="pi-resource-path"><span>{pathLabel}</span><span className="pi-resource-path-value" title={path}>{path}</span></div>
        <div className="pi-resource-summary"><span>{loadedSummary}</span></div>
        <p className="pi-resource-disclosure">{trustDisclosure}</p>
        {isolationDisclosure !== undefined && <p className="pi-resource-disclosure">{isolationDisclosure}</p>}
      </div>
      <div className="pi-resource-card-actions">
        {actions.map((action) => (
          <button key={action.testId} className="compact-button" type="button" onClick={() => run(action.onClick)} disabled={disabled} data-testid={action.testId}>
            {action.icon} {action.label}
          </button>
        ))}
      </div>
      <div className="pi-resource-card-diagnostics"><PiDiagnostics diagnostics={diagnostics} compact /></div>
    </article>
  );
}

function PiDiagnostics({ diagnostics, compact = false }: { diagnostics: readonly PiResourceDiagnostic[]; compact?: boolean }) {
  if (diagnostics.length === 0) {
    return <p className="empty-setting" data-testid={compact ? "pi-resource-diagnostics-empty" : "pi-resource-diagnostics-none"}>No diagnostics.</p>;
  }
  return (
    <details className="pi-resource-diagnostics" data-testid={compact ? "pi-resource-diagnostics" : "pi-resource-diagnostics-summary"}>
      <summary>{diagnostics.length} diagnostic{diagnostics.length === 1 ? "" : "s"}</summary>
      <ul>
        {diagnostics.map((diagnostic, index) => (
          <li key={`${diagnostic.source}-${diagnostic.path ?? ""}-${diagnostic.message}-${index}`}>
            <strong>{diagnostic.type}</strong> {diagnostic.message}
            {diagnostic.path !== undefined && <code title={diagnostic.path}>{diagnostic.path}</code>}
          </li>
        ))}
      </ul>
    </details>
  );
}

export type { PiResourcesSettingsActions, PiResourcesSettingsProps } from "@vc-agent/contracts";
