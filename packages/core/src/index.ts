export interface EmptyApplicationState {
  readonly projects: 0;
  readonly threads: 0;
  readonly modelProfiles: 0;
  readonly taskAssignments: 0;
}

export function createEmptyApplicationState(): EmptyApplicationState {
  return {
    projects: 0,
    threads: 0,
    modelProfiles: 0,
    taskAssignments: 0
  };
}
