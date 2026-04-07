import { describe, expect, it } from 'vitest';

import {
  buildDelegatedRuntimeHandleV1,
  delegatedRuntimeArtifactRefs,
} from '../src/delegated-runtime-handle.js';

describe('delegated runtime handle', () => {
  it('builds one canonical delegated runtime handle from run, assignment, and session lineage', () => {
    const handle = buildDelegatedRuntimeHandleV1({
      project_run_id: 'run-alpha',
      assignment_id: 'assignment-beta',
      session_id: 'session-gamma',
      task_id: 'task-delta',
      checkpoint_id: 'checkpoint-epsilon',
      parent_session_id: 'session-parent',
      forked_from_assignment_id: 'assignment-source',
      forked_from_session_id: 'session-source',
    });

    expect(handle).toEqual({
      version: 1,
      identity: {
        project_run_id: 'run-alpha',
        assignment_id: 'assignment-beta',
        session_id: 'session-gamma',
        runtime_run_id: 'run-alpha__assignment-beta',
      },
      lineage: {
        task_id: 'task-delta',
        checkpoint_id: 'checkpoint-epsilon',
        parent_session_id: 'session-parent',
        forked_from_assignment_id: 'assignment-source',
        forked_from_session_id: 'session-source',
      },
      artifacts: {
        manifest_path: 'artifacts/runs/run-alpha__assignment-beta/manifest.json',
        spans_path: 'artifacts/runs/run-alpha__assignment-beta/spans.jsonl',
        runtime_diagnostics_bridge_path: 'artifacts/runs/run-alpha__assignment-beta/runtime_diagnostics_bridge_v1.json',
      },
    });
  });

  it('derives canonical artifact refs from a bare runtime_run_id', () => {
    expect(delegatedRuntimeArtifactRefs({ runtime_run_id: 'run-zeta__assignment-eta' })).toEqual({
      manifest_path: 'artifacts/runs/run-zeta__assignment-eta/manifest.json',
      spans_path: 'artifacts/runs/run-zeta__assignment-eta/spans.jsonl',
      runtime_diagnostics_bridge_path: 'artifacts/runs/run-zeta__assignment-eta/runtime_diagnostics_bridge_v1.json',
    });
  });
});
