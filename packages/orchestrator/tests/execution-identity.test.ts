import { describe, expect, it } from 'vitest';

import {
  buildDelegatedExecutionIdentity,
  directDelegatedExecutionManifestPath,
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
      runtime_run_id: 'delegated-y4c7A3aaWnE5ovqEd8j0PjrekfG0_CFpF9gwqxENHIs',
    });
    expect(delegatedExecutionManifestPath(identity)).toBe(
      'artifacts/delegated-runs/team/delegated-y4c7A3aaWnE5ovqEd8j0PjrekfG0_CFpF9gwqxENHIs/manifest.json',
    );
    expect(directDelegatedExecutionManifestPath(identity)).toBe(
      'artifacts/delegated-runs/direct/delegated-y4c7A3aaWnE5ovqEd8j0PjrekfG0_CFpF9gwqxENHIs/manifest.json',
    );
    expect(directDelegatedExecutionManifestPath(identity)).not.toBe(
      delegatedExecutionManifestPath(identity),
    );
  });

  it('cannot alias adversarial project-run and assignment tuples', () => {
    const left = buildDelegatedExecutionIdentity({ project_run_id: 'a', assignment_id: 'b__c' });
    const right = buildDelegatedExecutionIdentity({ project_run_id: 'a__b', assignment_id: 'c' });

    expect(left.runtime_run_id).not.toBe(right.runtime_run_id);
    expect(delegatedExecutionManifestPath(left)).not.toBe(delegatedExecutionManifestPath(right));
  });

  it.each([
    { project_run_id: '../escape', assignment_id: 'assignment' },
    { project_run_id: 'run/child', assignment_id: 'assignment' },
    { project_run_id: 'run', assignment_id: '../escape' },
    { project_run_id: 'run', assignment_id: 'assignment/child' },
  ])('rejects unsafe identity components before path derivation', input => {
    expect(() => buildDelegatedExecutionIdentity(input)).toThrow(/invalid delegated execution identity/);
  });

  it('accepts a bare runtime_run_id object for manifest path derivation', () => {
    expect(delegatedExecutionManifestPath({ runtime_run_id: 'run-gamma__assignment-delta' })).toBe(
      'artifacts/delegated-runs/team/run-gamma__assignment-delta/manifest.json',
    );
  });

  it('rejects an unsafe bare runtime_run_id before path derivation', () => {
    expect(() => delegatedExecutionManifestPath({ runtime_run_id: '../escape' }))
      .toThrow(/invalid delegated execution identity/);
  });
});
