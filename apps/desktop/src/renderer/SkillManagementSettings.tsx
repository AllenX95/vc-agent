import { FolderOpen, RefreshCw, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  PiResourceDiagnostic,
  PiResourcesSettingsActions,
  PiResourcesSettingsProps
} from "@vc-agent/contracts";

/**
 * Dedicated Skills settings surface. Discovery remains read-only here; the
 * only mutation is the explicit per-Skill enable/disable intent.
 */
export function SkillManagementSettings({ state, actions, disabled = false }: PiResourcesSettingsProps) {
  const run = (action: () => void | Promise<void>) => {
    void Promise.resolve().then(action).catch(() => undefined);
  };
  const items = state.skills.items ?? [];
  const [optimisticEnabled, setOptimisticEnabled] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setOptimisticEnabled((current) => {
      const next = { ...current };
      for (const item of items) if (next[item.id] === item.enabled) delete next[item.id];
      return next;
    });
  }, [items]);
  return (
    <section className="settings-section skill-management-settings" data-testid="skill-management-settings">
      <div className="settings-section-header">
        <div>
          <span className="eyebrow">Pi-native Skills</span>
          <h2>Skills</h2>
          <p>
            Skills are discovered only from the dedicated VC Agent directory. Disabled Skills stay on disk but are
            omitted from Pi's runtime until you enable them again.
          </p>
        </div>
        <button className="compact-button" type="button" onClick={() => run(actions.onReload)} disabled={disabled} data-testid="pi-skills-reload">
          <RefreshCw size={15} /> Reload
        </button>
      </div>

      <div className="skill-management-source">
        <div className="pi-resource-path"><span>Dedicated directory</span><span className="pi-resource-path-value" title={state.skills.directoryPath}>{state.skills.directoryPath}</span></div>
        <div className="pi-resource-summary"><span>{state.skills.loadedCount} enabled · {items.length} discovered</span><span className={`doctor-status ${state.skills.status}`} role="status">{state.skills.status}</span></div>
        <p className="pi-resource-disclosure">{state.skills.trustDisclosure}</p>
        <p className="pi-resource-disclosure">{state.skills.sourceIsolationDisclosure}</p>
        <div className="pi-resource-card-actions">
          <button className="compact-button" type="button" onClick={() => run(actions.onOpenSkillsFolder)} disabled={disabled} data-testid="pi-skills-open-folder"><FolderOpen size={14} /> Open dedicated folder</button>
          <button className="compact-button" type="button" onClick={() => run(actions.onImportSkill)} disabled={disabled} data-testid="pi-skills-import-copy"><Upload size={14} /> Import Copy</button>
        </div>
      </div>

      <div className="skill-management-list" data-testid="pi-skills-list">
        {items.length === 0 ? <p className="empty-setting">No Skills discovered.</p> : items.map((skill) => {
          const enabled = optimisticEnabled[skill.id] ?? skill.enabled;
          return <label className={`skill-management-row${enabled ? " enabled" : " disabled"}`} key={skill.id} data-testid={`pi-skill-${encodeURIComponent(skill.id)}`}>
            <input
              type="checkbox"
              checked={enabled}
              disabled={disabled || actions.onSetSkillEnabled === undefined}
              onChange={(event) => {
                const nextEnabled = event.currentTarget.checked;
                setOptimisticEnabled((current) => ({ ...current, [skill.id]: nextEnabled }));
                if (actions.onSetSkillEnabled !== undefined) {
                  void Promise.resolve(actions.onSetSkillEnabled(skill.id, nextEnabled)).catch(() => {
                    setOptimisticEnabled((current) => ({ ...current, [skill.id]: skill.enabled }));
                  });
                }
              }}
              aria-label={`${enabled ? "Disable" : "Enable"} ${skill.name}`}
            />
            <span className="skill-management-copy">
              <strong>{skill.name}</strong>
              <span>{skill.description}</span>
              <code>{skill.relativePath}</code>
            </span>
            <span className={`doctor-status ${enabled ? "ready" : "unavailable"}`}>{enabled ? "enabled" : "disabled"}</span>
          </label>
        })}
      </div>

      <SkillDiagnostics diagnostics={state.skills.diagnostics} />
      {state.reloadPending && <p className="integration-runtime-status" role="status">Reload queued until the active Turn closes.</p>}
    </section>
  );
}

function SkillDiagnostics({ diagnostics }: { diagnostics: readonly PiResourceDiagnostic[] }) {
  if (diagnostics.length === 0) return <p className="empty-setting" data-testid="pi-skills-diagnostics-none">No diagnostics.</p>;
  return (
    <details className="pi-resource-diagnostics" data-testid="pi-skills-diagnostics">
      <summary>{diagnostics.length} diagnostic{diagnostics.length === 1 ? "" : "s"}</summary>
      <ul>
        {diagnostics.map((diagnostic, index) => <li key={`${diagnostic.source}-${diagnostic.path ?? ""}-${diagnostic.message}-${index}`}><strong>{diagnostic.type}</strong> {diagnostic.message}{diagnostic.path !== undefined && <code title={diagnostic.path}>{diagnostic.path}</code>}</li>)}
      </ul>
    </details>
  );
}

export type { PiResourcesSettingsActions, PiResourcesSettingsProps } from "@vc-agent/contracts";
