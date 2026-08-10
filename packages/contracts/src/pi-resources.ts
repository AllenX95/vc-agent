import { z } from "zod";

/**
 * The three resource families shown by the Pi resource settings view.
 *
 * This contract intentionally describes an observation surface.  It does not
 * contain admission, activation, revision, schema, or per-tool permission
 * state; those concepts are deliberately absent from the Pi-native resource
 * runtime.
 */
export const piResourceKindSchema = z.enum(["extensions", "mcp", "skills"]);
export type PiResourceKind = z.infer<typeof piResourceKindSchema>;

export const piResourceStatusSchema = z.enum(["ready", "attention", "unavailable"]);
export type PiResourceStatus = z.infer<typeof piResourceStatusSchema>;

/** A sanitized, read-only resource loading observation. */
export const piResourceDiagnosticSchema = z.object({
  type: z.enum(["info", "warning", "error", "collision"]),
  source: z.enum(["extension", "mcp", "skill", "runtime"]),
  code: z.string().min(1).max(120).optional(),
  message: z.string().min(1).max(1_200),
  path: z.string().min(1).optional(),
  blocking: z.boolean().optional()
});
export type PiResourceDiagnostic = z.infer<typeof piResourceDiagnosticSchema>;

const piResourceCommonStateSchema = z.object({
  status: piResourceStatusSchema,
  diagnostics: z.array(piResourceDiagnosticSchema),
  /** A bounded, user-facing explanation of the trust model for this source. */
  trustDisclosure: z.string().min(1).max(1_200)
});

export const piExtensionsSettingsStateSchema = piResourceCommonStateSchema.extend({
  directoryPath: z.string().min(1),
  loadedCount: z.number().int().nonnegative(),
  /** True when one coarse project-local Pi resource switch is available. */
  projectResourcesTrusted: z.boolean().optional()
});
export type PiExtensionsSettingsState = z.infer<typeof piExtensionsSettingsStateSchema>;

export const piMcpSettingsStateSchema = piResourceCommonStateSchema.extend({
  configPath: z.string().min(1),
  serverCount: z.number().int().nonnegative(),
  connectedServerCount: z.number().int().nonnegative()
});
export type PiMcpSettingsState = z.infer<typeof piMcpSettingsStateSchema>;

export const piSkillsSettingsStateSchema = piResourceCommonStateSchema.extend({
  directoryPath: z.string().min(1),
  loadedCount: z.number().int().nonnegative(),
  /** The dedicated-source statement is separate so it remains visible even when empty. */
  sourceIsolationDisclosure: z.string().min(1).max(1_200)
});
export type PiSkillsSettingsState = z.infer<typeof piSkillsSettingsStateSchema>;

export const piResourcesSettingsStateSchema = z.object({
  schemaVersion: z.literal(1),
  generation: z.number().int().nonnegative(),
  reloadPending: z.boolean(),
  extensions: piExtensionsSettingsStateSchema,
  mcp: piMcpSettingsStateSchema,
  skills: piSkillsSettingsStateSchema,
  /** Aggregated diagnostics are convenient for status strips and telemetry-free UI tests. */
  diagnostics: z.array(piResourceDiagnosticSchema)
});
export type PiResourcesSettingsState = z.infer<typeof piResourcesSettingsStateSchema>;

/**
 * Renderer intent callbacks.  These callbacks intentionally do not accept a
 * HostCommand.  The eventual IPC adapter can translate each intent to its
 * own command without coupling this view to the retired integration control
 * plane.
 */
export interface PiResourcesSettingsActions {
  onOpenExtensionsFolder: () => void | Promise<void>;
  onOpenMcpConfig: () => void | Promise<void>;
  onOpenSkillsFolder: () => void | Promise<void>;
  onImportSkill: () => void | Promise<void>;
  onReload: () => void | Promise<void>;
  onSetProjectResourcesTrusted?: (trusted: boolean) => void | Promise<void>;
}

/** Backwards-friendly name for callers that prefer an explicit callback suffix. */
export type PiResourcesSettingsCallbacks = PiResourcesSettingsActions;

/** The props are deliberately state + intents only; no legacy Host command type leaks into the view. */
export interface PiResourcesSettingsProps {
  state: PiResourcesSettingsState;
  actions: PiResourcesSettingsActions;
  disabled?: boolean;
}
