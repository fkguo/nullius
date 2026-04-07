import * as path from 'node:path';
import {
  buildDelegatedExecutionIdentity,
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

export function delegatedRuntimeSpansPath(identity: Pick<DelegatedExecutionIdentity, 'runtime_run_id'>): string {
  return path.posix.join('artifacts', 'runs', identity.runtime_run_id, 'spans.jsonl');
}

export function delegatedRuntimeDiagnosticsBridgePath(
  identity: Pick<DelegatedExecutionIdentity, 'runtime_run_id'>,
): string {
  return path.posix.join('artifacts', 'runs', identity.runtime_run_id, 'runtime_diagnostics_bridge_v1.json');
}

export function delegatedRuntimeArtifactRefs(identity: Pick<DelegatedExecutionIdentity, 'runtime_run_id'>): DelegatedRuntimeHandleV1['artifacts'] {
  return {
    manifest_path: delegatedExecutionManifestPath(identity),
    spans_path: delegatedRuntimeSpansPath(identity),
    runtime_diagnostics_bridge_path: delegatedRuntimeDiagnosticsBridgePath(identity),
  };
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
  const identity = buildDelegatedExecutionIdentity({
    project_run_id: input.project_run_id,
    assignment_id: input.assignment_id,
  });
  return {
    version: 1,
    identity: {
      ...identity,
      session_id: input.session_id,
    },
    lineage: {
      task_id: input.task_id,
      checkpoint_id: input.checkpoint_id,
      parent_session_id: input.parent_session_id,
      forked_from_assignment_id: input.forked_from_assignment_id,
      forked_from_session_id: input.forked_from_session_id,
    },
    artifacts: delegatedRuntimeArtifactRefs(identity),
  };
}
