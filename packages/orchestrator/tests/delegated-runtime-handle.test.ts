import { describe, expect, it } from 'vitest';

import {
  assertDelegatedRuntimeHandleV1,
  buildDelegatedRuntimeHandleV1,
  delegatedRuntimeArtifactRefs,
  type DelegatedRuntimeHandleV1,
} from '../src/delegated-runtime-handle.js';

function makeHandle(): DelegatedRuntimeHandleV1 {
  return buildDelegatedRuntimeHandleV1({
    project_run_id: 'run-alpha',
    assignment_id: 'assignment-beta',
    session_id: 'session-gamma',
    task_id: 'task-delta',
    checkpoint_id: 'checkpoint-epsilon',
    parent_session_id: 'session-parent',
    forked_from_assignment_id: 'assignment-source',
    forked_from_session_id: 'session-source',
  });
}

describe('delegated runtime handle', () => {
  it('builds one canonical delegated runtime handle from run, assignment, and session lineage', () => {
    const handle = makeHandle();

    expect(handle).toEqual({
      version: 1,
      identity: {
        project_run_id: 'run-alpha',
        assignment_id: 'assignment-beta',
        session_id: 'session-gamma',
        runtime_run_id: 'delegated-y4c7A3aaWnE5ovqEd8j0PjrekfG0_CFpF9gwqxENHIs',
      },
      lineage: {
        task_id: 'task-delta',
        checkpoint_id: 'checkpoint-epsilon',
        parent_session_id: 'session-parent',
        forked_from_assignment_id: 'assignment-source',
        forked_from_session_id: 'session-source',
      },
      artifacts: {
        manifest_path: 'artifacts/delegated-runs/team/delegated-y4c7A3aaWnE5ovqEd8j0PjrekfG0_CFpF9gwqxENHIs/manifest.json',
        spans_path: 'artifacts/delegated-runs/team/delegated-y4c7A3aaWnE5ovqEd8j0PjrekfG0_CFpF9gwqxENHIs/spans.jsonl',
        runtime_diagnostics_bridge_path: 'artifacts/delegated-runs/team/delegated-y4c7A3aaWnE5ovqEd8j0PjrekfG0_CFpF9gwqxENHIs/runtime_diagnostics_bridge_v1.json',
      },
    });
  });

  it('derives distinct handles for delimiter-ambiguous source tuples', () => {
    const common = {
      session_id: 'session',
      task_id: 'task',
      checkpoint_id: null,
      parent_session_id: null,
      forked_from_assignment_id: null,
      forked_from_session_id: null,
    };
    const left = buildDelegatedRuntimeHandleV1({
      ...common,
      project_run_id: 'a',
      assignment_id: 'b__c',
    });
    const right = buildDelegatedRuntimeHandleV1({
      ...common,
      project_run_id: 'a__b',
      assignment_id: 'c',
    });

    expect(left.identity.runtime_run_id).not.toBe(right.identity.runtime_run_id);
    expect(left.artifacts.manifest_path).not.toBe(right.artifacts.manifest_path);
  });

  it('returns a detached frozen snapshot rather than the caller-owned handle', () => {
    const raw = JSON.parse(JSON.stringify(makeHandle())) as DelegatedRuntimeHandleV1;
    const validated = assertDelegatedRuntimeHandleV1(raw);

    raw.identity.project_run_id = 'forged-after-validation';
    raw.artifacts.manifest_path = 'forged/after-validation.json';

    expect(validated.identity.project_run_id).toBe('run-alpha');
    expect(validated.artifacts.manifest_path).toContain(
      'delegated-y4c7A3aaWnE5ovqEd8j0PjrekfG0_CFpF9gwqxENHIs',
    );
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.identity)).toBe(true);
    expect(Object.isFrozen(validated.lineage)).toBe(true);
    expect(Object.isFrozen(validated.artifacts)).toBe(true);
  });

  it('rejects changing accessors without invoking them', () => {
    const raw = JSON.parse(JSON.stringify(makeHandle())) as DelegatedRuntimeHandleV1;
    let reads = 0;
    Object.defineProperty(raw.identity, 'project_run_id', {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? 'run-alpha' : 'forged-after-validation';
      },
    });

    expect(() => assertDelegatedRuntimeHandleV1(raw)).toThrow(/must be an own data property/);
    expect(reads).toBe(0);
  });

  it('rejects nested proxies without invoking their traps', () => {
    const raw = JSON.parse(JSON.stringify(makeHandle())) as DelegatedRuntimeHandleV1;
    let reads = 0;
    raw.identity = new Proxy(raw.identity, {
      get(target, property, receiver) {
        reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => assertDelegatedRuntimeHandleV1(raw)).toThrow(/plain non-proxy object/);
    expect(reads).toBe(0);
  });

  it('derives canonical artifact refs from a bare runtime_run_id', () => {
    expect(delegatedRuntimeArtifactRefs({ runtime_run_id: 'run-zeta__assignment-eta' })).toEqual({
      manifest_path: 'artifacts/delegated-runs/team/run-zeta__assignment-eta/manifest.json',
      spans_path: 'artifacts/delegated-runs/team/run-zeta__assignment-eta/spans.jsonl',
      runtime_diagnostics_bridge_path: 'artifacts/delegated-runs/team/run-zeta__assignment-eta/runtime_diagnostics_bridge_v1.json',
    });
  });

  it.each([
    ['project run traversal', { project_run_id: '../escape' }],
    ['project run child path', { project_run_id: 'run/child' }],
    ['assignment traversal', { assignment_id: '../escape' }],
    ['assignment child path', { assignment_id: 'assignment/child' }],
    ['session path', { session_id: 'session/child' }],
    ['task traversal', { task_id: '../task' }],
  ])('refuses unsafe builder identity: %s', (_label, override) => {
    expect(() => buildDelegatedRuntimeHandleV1({
      project_run_id: 'run-alpha',
      assignment_id: 'assignment-beta',
      session_id: 'session-gamma',
      task_id: 'task-delta',
      checkpoint_id: null,
      parent_session_id: null,
      forked_from_assignment_id: null,
      forked_from_session_id: null,
      ...override,
    })).toThrow(/invalid delegated runtime handle/);
  });

  it('refuses unsafe bare runtime ids before deriving artifact paths', () => {
    expect(() => delegatedRuntimeArtifactRefs({ runtime_run_id: '../escape' }))
      .toThrow(/one safe path segment/);
    expect(() => delegatedRuntimeArtifactRefs({ runtime_run_id: 'run/child' }))
      .toThrow(/one safe path segment/);
  });

  it.each([
    {
      label: 'version',
      corrupt: (handle: DelegatedRuntimeHandleV1): unknown => ({ ...handle, version: 2 }),
      error: 'unsupported delegated runtime handle: version must be 1',
    },
    {
      label: 'runtime identity',
      corrupt: (handle: DelegatedRuntimeHandleV1): unknown => ({
        ...handle,
        identity: { ...handle.identity, runtime_run_id: 'forged-runtime' },
      }),
      error: 'identity.runtime_run_id is not canonical',
    },
    ...([
      'manifest_path',
      'spans_path',
      'runtime_diagnostics_bridge_path',
    ] as const).map(field => ({
      label: field,
      corrupt: (handle: DelegatedRuntimeHandleV1): unknown => ({
        ...handle,
        artifacts: { ...handle.artifacts, [field]: `forged/${field}` },
      }),
      error: `artifacts.${field} is not canonical`,
    })),
  ])('rejects a non-canonical $label', ({ corrupt, error }) => {
    expect(() => assertDelegatedRuntimeHandleV1(corrupt(makeHandle()))).toThrow(error);
  });
});
