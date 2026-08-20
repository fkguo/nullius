import * as path from 'node:path';
import { types as utilTypes } from 'node:util';
import {
  DIRECT_DELEGATED_RUNTIME_ARTIFACT_ROOT,
  TEAM_DELEGATED_RUNTIME_ARTIFACT_ROOT,
  buildDelegatedExecutionIdentity,
  directDelegatedExecutionManifestPath,
  delegatedExecutionManifestPath,
  type DelegatedExecutionIdentity,
} from './execution-identity.js';

export interface DelegatedRuntimeHandleV1 {
  version: 1;
  identity: DelegatedExecutionIdentity & {
    session_id: string;
  };
  lineage: {
    task_id: string;
    checkpoint_id: string | null;
    parent_session_id: string | null;
    forked_from_assignment_id: string | null;
    forked_from_session_id: string | null;
  };
  artifacts: {
    manifest_path: string;
    spans_path: string;
    runtime_diagnostics_bridge_path: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`invalid delegated runtime handle: ${field} must be a plain non-proxy object`);
  }
  return value;
}

function requireDataProperty(record: Record<string, unknown>, key: string, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !('value' in descriptor)) {
    throw new Error(`invalid delegated runtime handle: ${field} must be an own data property`);
  }
  return descriptor.value;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`invalid delegated runtime handle: ${field} must be a non-empty string`);
  }
  return value;
}

function requireSafePathSegment(value: unknown, field: string, maxLength = 128): string {
  const resolved = requireNonEmptyString(value, field);
  if (resolved.length > maxLength
    || !/^[A-Za-z0-9._-]+$/.test(resolved)
    || resolved === '.'
    || resolved.includes('..')) {
    throw new Error(
      `invalid delegated runtime handle: ${field} must be one safe path segment`,
    );
  }
  return resolved;
}

function requireSafeIdentifier(value: unknown, field: string): string {
  const resolved = requireNonEmptyString(value, field);
  if (resolved.length > 256
    || resolved === '.'
    || resolved === '..'
    || /[\/\\\u0000-\u001f\u007f]/.test(resolved)) {
    throw new Error(
      `invalid delegated runtime handle: ${field} must be a bounded identifier without path separators or control characters`,
    );
  }
  return resolved;
}

function requireNullableSafeIdentifier(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requireSafeIdentifier(value, field);
}

export function delegatedRuntimeSpansPath(identity: Pick<DelegatedExecutionIdentity, 'runtime_run_id'>): string {
  const runtimeRunId = requireSafePathSegment(identity.runtime_run_id, 'identity.runtime_run_id', 200);
  return path.posix.join(TEAM_DELEGATED_RUNTIME_ARTIFACT_ROOT, runtimeRunId, 'spans.jsonl');
}

export function delegatedRuntimeDiagnosticsBridgePath(
  identity: Pick<DelegatedExecutionIdentity, 'runtime_run_id'>,
): string {
  const runtimeRunId = requireSafePathSegment(identity.runtime_run_id, 'identity.runtime_run_id', 200);
  return path.posix.join(
    TEAM_DELEGATED_RUNTIME_ARTIFACT_ROOT,
    runtimeRunId,
    'runtime_diagnostics_bridge_v1.json',
  );
}

// This is the single artifact-ref seam shared by both handle construction and
// the direct runtime fallback path, so path coherence stays structural.
export function delegatedRuntimeArtifactRefs(identity: Pick<DelegatedExecutionIdentity, 'runtime_run_id'>): DelegatedRuntimeHandleV1['artifacts'] {
  const runtimeRunId = requireSafePathSegment(identity.runtime_run_id, 'identity.runtime_run_id', 200);
  return {
    manifest_path: delegatedExecutionManifestPath({ runtime_run_id: runtimeRunId }),
    spans_path: delegatedRuntimeSpansPath({ runtime_run_id: runtimeRunId }),
    runtime_diagnostics_bridge_path: delegatedRuntimeDiagnosticsBridgePath({ runtime_run_id: runtimeRunId }),
  };
}

export function directDelegatedRuntimeArtifactRefs(
  identity: Pick<DelegatedExecutionIdentity, 'runtime_run_id'>,
): DelegatedRuntimeHandleV1['artifacts'] {
  const runtimeRunId = requireSafePathSegment(identity.runtime_run_id, 'identity.runtime_run_id', 200);
  return {
    manifest_path: directDelegatedExecutionManifestPath({ runtime_run_id: runtimeRunId }),
    spans_path: path.posix.join(DIRECT_DELEGATED_RUNTIME_ARTIFACT_ROOT, runtimeRunId, 'spans.jsonl'),
    runtime_diagnostics_bridge_path: path.posix.join(
      DIRECT_DELEGATED_RUNTIME_ARTIFACT_ROOT,
      runtimeRunId,
      'runtime_diagnostics_bridge_v1.json',
    ),
  };
}

/**
 * Validate an untrusted delegated-runtime handle before any runtime state is
 * read or written. Identity and artifact locations are derived authority: a
 * caller may transport them, but may not redefine them.
 */
export function assertDelegatedRuntimeHandleV1(raw: unknown): DelegatedRuntimeHandleV1 {
  const handle = requireRecord(raw, 'root');
  if (requireDataProperty(handle, 'version', 'version') !== 1) {
    throw new Error('unsupported delegated runtime handle: version must be 1');
  }

  const identity = requireRecord(requireDataProperty(handle, 'identity', 'identity'), 'identity');
  const projectRunId = requireSafePathSegment(
    requireDataProperty(identity, 'project_run_id', 'identity.project_run_id'),
    'identity.project_run_id',
  );
  const assignmentId = requireSafePathSegment(
    requireDataProperty(identity, 'assignment_id', 'identity.assignment_id'),
    'identity.assignment_id',
    64,
  );
  const runtimeRunId = requireSafePathSegment(
    requireDataProperty(identity, 'runtime_run_id', 'identity.runtime_run_id'),
    'identity.runtime_run_id',
    200,
  );
  const sessionId = requireSafeIdentifier(
    requireDataProperty(identity, 'session_id', 'identity.session_id'),
    'identity.session_id',
  );
  const canonicalIdentity = buildDelegatedExecutionIdentity({
    project_run_id: projectRunId,
    assignment_id: assignmentId,
  });
  if (runtimeRunId !== canonicalIdentity.runtime_run_id) {
    throw new Error(
      'invalid delegated runtime handle: identity.runtime_run_id is not canonical for project_run_id and assignment_id',
    );
  }

  const lineage = requireRecord(requireDataProperty(handle, 'lineage', 'lineage'), 'lineage');
  const taskId = requireSafeIdentifier(
    requireDataProperty(lineage, 'task_id', 'lineage.task_id'),
    'lineage.task_id',
  );
  const checkpointId = requireNullableSafeIdentifier(
    requireDataProperty(lineage, 'checkpoint_id', 'lineage.checkpoint_id'),
    'lineage.checkpoint_id',
  );
  const parentSessionId = requireNullableSafeIdentifier(
    requireDataProperty(lineage, 'parent_session_id', 'lineage.parent_session_id'),
    'lineage.parent_session_id',
  );
  const forkedFromAssignmentId = requireNullableSafeIdentifier(
    requireDataProperty(lineage, 'forked_from_assignment_id', 'lineage.forked_from_assignment_id'),
    'lineage.forked_from_assignment_id',
  );
  const forkedFromSessionId = requireNullableSafeIdentifier(
    requireDataProperty(lineage, 'forked_from_session_id', 'lineage.forked_from_session_id'),
    'lineage.forked_from_session_id',
  );

  const artifacts = requireRecord(requireDataProperty(handle, 'artifacts', 'artifacts'), 'artifacts');
  const canonicalArtifacts = delegatedRuntimeArtifactRefs(canonicalIdentity);
  for (const field of [
    'manifest_path',
    'spans_path',
    'runtime_diagnostics_bridge_path',
  ] as const) {
    const actual = requireNonEmptyString(
      requireDataProperty(artifacts, field, `artifacts.${field}`),
      `artifacts.${field}`,
    );
    if (actual !== canonicalArtifacts[field]) {
      throw new Error(`invalid delegated runtime handle: artifacts.${field} is not canonical`);
    }
  }

  return Object.freeze({
    version: 1,
    identity: Object.freeze({
      ...canonicalIdentity,
      session_id: sessionId,
    }),
    lineage: Object.freeze({
      task_id: taskId,
      checkpoint_id: checkpointId,
      parent_session_id: parentSessionId,
      forked_from_assignment_id: forkedFromAssignmentId,
      forked_from_session_id: forkedFromSessionId,
    }),
    artifacts: Object.freeze({ ...canonicalArtifacts }),
  });
}

export function buildDelegatedRuntimeHandleV1(input: {
  project_run_id: string;
  assignment_id: string;
  session_id: string;
  task_id: string;
  checkpoint_id: string | null;
  parent_session_id: string | null;
  forked_from_assignment_id: string | null;
  forked_from_session_id: string | null;
}): DelegatedRuntimeHandleV1 {
  const projectRunId = requireSafePathSegment(input.project_run_id, 'identity.project_run_id');
  const assignmentId = requireSafePathSegment(input.assignment_id, 'identity.assignment_id', 64);
  const sessionId = requireSafeIdentifier(input.session_id, 'identity.session_id');
  const taskId = requireSafeIdentifier(input.task_id, 'lineage.task_id');
  const checkpointId = requireNullableSafeIdentifier(input.checkpoint_id, 'lineage.checkpoint_id');
  const parentSessionId = requireNullableSafeIdentifier(input.parent_session_id, 'lineage.parent_session_id');
  const forkedFromAssignmentId = requireNullableSafeIdentifier(
    input.forked_from_assignment_id,
    'lineage.forked_from_assignment_id',
  );
  const forkedFromSessionId = requireNullableSafeIdentifier(
    input.forked_from_session_id,
    'lineage.forked_from_session_id',
  );
  const identity = buildDelegatedExecutionIdentity({
    project_run_id: projectRunId,
    assignment_id: assignmentId,
  });
  const handle: DelegatedRuntimeHandleV1 = {
    version: 1,
    identity: {
      ...identity,
      session_id: sessionId,
    },
    lineage: {
      task_id: taskId,
      checkpoint_id: checkpointId,
      parent_session_id: parentSessionId,
      forked_from_assignment_id: forkedFromAssignmentId,
      forked_from_session_id: forkedFromSessionId,
    },
    artifacts: delegatedRuntimeArtifactRefs(identity),
  };
  return assertDelegatedRuntimeHandleV1(handle);
}
