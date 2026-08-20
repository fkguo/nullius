import { createHash } from 'node:crypto';

export interface DelegatedExecutionIdentity {
  project_run_id: string;
  assignment_id: string;
  runtime_run_id: string;
}

export const DELEGATED_RUNTIME_ARTIFACT_ROOT = 'artifacts/delegated-runs';
export const DIRECT_DELEGATED_RUNTIME_ARTIFACT_ROOT = `${DELEGATED_RUNTIME_ARTIFACT_ROOT}/direct`;
export const TEAM_DELEGATED_RUNTIME_ARTIFACT_ROOT = `${DELEGATED_RUNTIME_ARTIFACT_ROOT}/team`;

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;

function requireSafeIdentitySegment(value: string, field: string, maxLength: number): string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || !SAFE_PATH_SEGMENT.test(value)
    || value === '.'
    || value.includes('..')) {
    throw new Error(
      `invalid delegated execution identity: ${field} must be one safe path segment of at most ${maxLength} characters`,
    );
  }
  return value;
}

function deriveRuntimeRunId(projectRunId: string, assignmentId: string): string {
  // Hash the canonical tuple, rather than joining with an in-band delimiter:
  // ("a", "b__c") and ("a__b", "c") must never share durable state.
  const digest = createHash('sha256')
    .update(JSON.stringify([projectRunId, assignmentId]), 'utf8')
    .digest('base64url');
  return `delegated-${digest}`;
}

export function buildDelegatedExecutionIdentity(input: {
  project_run_id: string;
  assignment_id: string;
}): DelegatedExecutionIdentity {
  const projectRunId = requireSafeIdentitySegment(input.project_run_id, 'project_run_id', 128);
  const assignmentId = requireSafeIdentitySegment(input.assignment_id, 'assignment_id', 64);
  return {
    project_run_id: projectRunId,
    assignment_id: assignmentId,
    runtime_run_id: deriveRuntimeRunId(projectRunId, assignmentId),
  };
}

export function delegatedExecutionManifestPath(identity: Pick<DelegatedExecutionIdentity, 'runtime_run_id'>): string {
  const runtimeRunId = requireSafeIdentitySegment(identity.runtime_run_id, 'runtime_run_id', 200);
  return `${TEAM_DELEGATED_RUNTIME_ARTIFACT_ROOT}/${runtimeRunId}/manifest.json`;
}

export function directDelegatedExecutionManifestPath(
  identity: Pick<DelegatedExecutionIdentity, 'runtime_run_id'>,
): string {
  const runtimeRunId = requireSafeIdentitySegment(identity.runtime_run_id, 'runtime_run_id', 200);
  return `${DIRECT_DELEGATED_RUNTIME_ARTIFACT_ROOT}/${runtimeRunId}/manifest.json`;
}
