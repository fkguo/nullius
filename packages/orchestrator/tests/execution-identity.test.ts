import { describe, expect, it } from 'vitest';

import {
  buildDelegatedExecutionIdentity,
  delegatedExecutionManifestPath,
} from '../src/execution-identity.js';

describe('delegated execution identity', () => {
  it('derives one canonical runtime id and manifest path from project run plus assignment id', () => {
    const identity = buildDelegatedExecutionIdentity({
      project_run_id: 'run-alpha',
      assignment_id: 'assignment-beta',
    });

    expect(identity).toEqual({
      project_run_id: 'run-alpha',
      assignment_id: 'assignment-beta',
      runtime_run_id: 'run-alpha__assignment-beta',
    });
    expect(delegatedExecutionManifestPath(identity)).toBe(
      'artifacts/runs/run-alpha__assignment-beta/manifest.json',
    );
  });

  it('accepts a bare runtime_run_id object for manifest path derivation', () => {
    expect(delegatedExecutionManifestPath({ runtime_run_id: 'run-gamma__assignment-delta' })).toBe(
      'artifacts/runs/run-gamma__assignment-delta/manifest.json',
    );
  });
});
