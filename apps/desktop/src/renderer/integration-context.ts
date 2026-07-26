import type { IntegrationTaskContext, ModelProfile, Project, Thread } from "@vc-agent/contracts";

export interface IntegrationContextInput {
  readonly activeThread: Thread | undefined;
  readonly activeProject: Project | undefined;
  readonly activeProfile: ModelProfile | undefined;
  readonly latestTurnId: string | undefined;
  readonly accessMode: "standard" | "full";
}

/**
 * Resolve only the context that is actually selected in the desktop shell.
 * Callers must handle omitted fields as an actionable missing prerequisite.
 */
export function resolveIntegrationTaskContext(input: IntegrationContextInput): IntegrationTaskContext {
  return {
    ...(input.activeProject === undefined ? {} : { projectId: input.activeProject.id }),
    ...(input.activeThread === undefined ? {} : { threadId: input.activeThread.id }),
    ...(input.latestTurnId === undefined ? {} : { turnId: input.latestTurnId }),
    ...(input.activeProfile === undefined ? {} : { profileId: input.activeProfile.id }),
    ...(input.activeThread?.scope !== "unscoped" || input.activeThread.outputLocation === undefined ? {} : { outputLocation: input.activeThread.outputLocation }),
    accessMode: input.accessMode
  };
}

export function missingIntegrationContext(context: IntegrationTaskContext, requirements: readonly (keyof IntegrationTaskContext)[]): string[] {
  return requirements.filter((key) => context[key] === undefined).map((key) => key === "turnId" ? "parent Turn" : key === "profileId" ? "Model Profile" : key === "projectId" ? "Project" : key === "threadId" ? "Thread" : key === "outputLocation" ? "Output Location" : key);
}
