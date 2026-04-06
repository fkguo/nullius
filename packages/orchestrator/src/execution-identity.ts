export interface DelegatedExecutionIdentity {
  project_run_id: string;
  assignment_id: string;
  runtime_run_id: string;
}

export function buildDelegatedExecutionIdentity(input: {
  project_run_id: string;
  assignment_id: string;
}): DelegatedExecutionIdentity {
  return {
    project_run_id: input.project_run_id,
    assignment_id: input.assignment_id,
    runtime_run_id: `${input.project_run_id}__${input.assignment_id}`,
  };
}

export function delegatedExecutionManifestPath(identity: Pick<DelegatedExecutionIdentity, 'runtime_run_id'>): string {
  return `artifacts/runs/${identity.runtime_run_id}/manifest.json`;
}
