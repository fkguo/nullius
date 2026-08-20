import { describe, expect, it } from 'vitest';
import {
  ORCH_FLEET_STATUS,
  ORCH_POLICY_QUERY,
  ORCH_RUN_APPROVE,
  ORCH_RUN_CREATE,
  ORCH_RUN_LIST,
  ORCH_RUN_STATUS,
} from '@nullius/shared';

import type { ToolUseContent } from '../src/backends/chat-backend.js';
import { groupToolUsesForExecution } from '../src/agent-runner-tool-groups.js';
import { buildRuntimePermissionProfileV1 } from '../src/runtime-permission-profile.js';
import {
  buildRuntimeToolPermissionView,
  type ToolPermissionView,
} from '../src/tool-execution-policy.js';

function toolUse(id: string, name: string): ToolUseContent {
  return {
    type: 'tool_use',
    id,
    name,
    input: {},
  };
}

function permissionView(
  toolNames: string[],
  actorScope: 'agent_session' | 'delegated_assignment' = 'agent_session',
): ToolPermissionView {
  return buildRuntimeToolPermissionView(buildRuntimePermissionProfileV1({
    tools: toolNames.map(name => ({ name })),
    actorScope,
  }));
}

function groupedNames(
  groups: ReturnType<typeof groupToolUsesForExecution>,
): string[][] {
  return groups.map(group => group.map(execution => execution.toolUse.name));
}

describe('groupToolUsesForExecution', () => {
  it('returns no groups for an empty tool-use list', () => {
    expect(groupToolUsesForExecution([], permissionView([]))).toEqual([]);
  });

  it('keeps contiguous batch-safe read-only tools in a single group', () => {
    const names = [ORCH_RUN_STATUS, ORCH_RUN_LIST, ORCH_POLICY_QUERY];
    const groups = groupToolUsesForExecution([
      toolUse('tu_status', ORCH_RUN_STATUS),
      toolUse('tu_list', ORCH_RUN_LIST),
      toolUse('tu_policy', ORCH_POLICY_QUERY),
    ], permissionView(names));

    expect(groupedNames(groups)).toEqual([names]);
  });

  it('keeps serial-only tools as singleton groups, including unknown tools', () => {
    const names = [ORCH_RUN_CREATE, 'unknown_tool'];
    const groups = groupToolUsesForExecution([
      toolUse('tu_create', ORCH_RUN_CREATE),
      toolUse('tu_unknown', 'unknown_tool'),
    ], permissionView(names));

    expect(groupedNames(groups)).toEqual([
      [ORCH_RUN_CREATE],
      ['unknown_tool'],
    ]);
  });

  it('flushes the current batch-safe group before a serial-only tool and starts a new batch afterward', () => {
    const names = [
      ORCH_RUN_STATUS,
      ORCH_RUN_LIST,
      ORCH_RUN_CREATE,
      ORCH_POLICY_QUERY,
      ORCH_FLEET_STATUS,
    ];
    const groups = groupToolUsesForExecution([
      toolUse('tu_status', ORCH_RUN_STATUS),
      toolUse('tu_list', ORCH_RUN_LIST),
      toolUse('tu_create', ORCH_RUN_CREATE),
      toolUse('tu_policy', ORCH_POLICY_QUERY),
      toolUse('tu_fleet', ORCH_FLEET_STATUS),
    ], permissionView(names));

    expect(groupedNames(groups)).toEqual([
      [ORCH_RUN_STATUS, ORCH_RUN_LIST],
      [ORCH_RUN_CREATE],
      [ORCH_POLICY_QUERY, ORCH_FLEET_STATUS],
    ]);
  });

  it('preflights the entire response and denies any non-visible tool before returning groups', () => {
    expect(() => groupToolUsesForExecution([
      toolUse('tu_status', ORCH_RUN_STATUS),
      toolUse('tu_blocked', 'blocked_tool'),
    ], permissionView([ORCH_RUN_STATUS]))).toThrow(/blocked_tool is not visible/);
  });

  it.each(['agent_session', 'delegated_assignment'] as const)(
    'reserves approval-resolution tools for the host boundary in %s scope',
    actorScope => {
      expect(() => groupToolUsesForExecution([
        toolUse('tu_approve', ORCH_RUN_APPROVE),
      ], permissionView([ORCH_RUN_APPROVE], actorScope))).toThrow(/reserved for the host\/operator boundary/);
    },
  );

  it('does not accept a caller-forged concurrency policy and freezes the resulting plan', () => {
    const view = permissionView([ORCH_RUN_CREATE]);
    const forgedView: ToolPermissionView = {
      ...view,
      execution_policies: {
        ...view.execution_policies,
        [ORCH_RUN_CREATE]: {
          ...view.execution_policies[ORCH_RUN_CREATE]!,
          mutation_class: 'read_only',
          concurrency: 'batch_safe',
        },
      },
    };
    expect(() => groupToolUsesForExecution([
      toolUse('tu_create', ORCH_RUN_CREATE),
    ], forgedView)).toThrow(/stale or forged execution policy/);

    const groups = groupToolUsesForExecution([
      toolUse('tu_status', ORCH_RUN_STATUS),
    ], permissionView([ORCH_RUN_STATUS]));
    expect(Object.isFrozen(groups)).toBe(true);
    expect(Object.isFrozen(groups[0])).toBe(true);
    expect(Object.isFrozen(groups[0]?.[0])).toBe(true);
    expect(Object.isFrozen(groups[0]?.[0]?.executionPolicy)).toBe(true);
    expect(Object.isFrozen(groups[0]?.[0]?.toolUse)).toBe(true);
    expect(Object.isFrozen(groups[0]?.[0]?.toolUse.input)).toBe(true);
  });

  it('detaches and deeply freezes tool identity and input before authorization or dispatch', () => {
    const source = {
      type: 'tool_use' as const,
      id: 'tu_status',
      name: ORCH_RUN_STATUS,
      input: {
        run_id: 'run_original',
        nested: { value: 1 },
        items: [{ enabled: true }],
      },
    };
    const groups = groupToolUsesForExecution([source], permissionView([ORCH_RUN_STATUS]));
    const frozen = groups[0]![0]!.toolUse;

    source.id = 'tu_mutated';
    source.name = ORCH_RUN_CREATE;
    source.input.run_id = 'run_mutated';
    source.input.nested.value = 2;
    source.input.items[0]!.enabled = false;

    expect(frozen).toEqual({
      type: 'tool_use',
      id: 'tu_status',
      name: ORCH_RUN_STATUS,
      input: {
        items: [{ enabled: true }],
        nested: { value: 1 },
        run_id: 'run_original',
      },
    });
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.input)).toBe(true);
    expect(Object.isFrozen(frozen.input['nested'])).toBe(true);
    expect(Object.isFrozen(frozen.input['items'])).toBe(true);
    expect(Object.isFrozen((frozen.input['items'] as unknown[])[0])).toBe(true);
  });

  it('rejects accessors without invoking them', () => {
    let topLevelReads = 0;
    const accessorToolUse = {
      type: 'tool_use',
      id: 'tu_status',
      input: {},
    } as Record<string, unknown>;
    Object.defineProperty(accessorToolUse, 'name', {
      enumerable: true,
      get() {
        topLevelReads += 1;
        return ORCH_RUN_STATUS;
      },
    });
    expect(() => groupToolUsesForExecution(
      [accessorToolUse as ToolUseContent],
      permissionView([ORCH_RUN_STATUS]),
    )).toThrow(/accessor properties are not allowed/);
    expect(topLevelReads).toBe(0);

    let nestedReads = 0;
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, 'run_id', {
      enumerable: true,
      get() {
        nestedReads += 1;
        return 'run_1';
      },
    });
    expect(() => groupToolUsesForExecution(
      [{ type: 'tool_use', id: 'tu_status', name: ORCH_RUN_STATUS, input }],
      permissionView([ORCH_RUN_STATUS]),
    )).toThrow(/accessor properties are not allowed/);
    expect(nestedReads).toBe(0);
  });

  it('rejects Proxy values without invoking their traps', () => {
    let propertyReads = 0;
    const proxiedInput = new Proxy({ run_id: 'run_1' }, {
      get(target, key, receiver) {
        propertyReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(() => groupToolUsesForExecution(
      [{ type: 'tool_use', id: 'tu_status', name: ORCH_RUN_STATUS, input: proxiedInput }],
      permissionView([ORCH_RUN_STATUS]),
    )).toThrow(/Proxy values are not allowed/);
    expect(propertyReads).toBe(0);

    const proxiedToolUse = new Proxy(
      { type: 'tool_use' as const, id: 'tu_status', name: ORCH_RUN_STATUS, input: {} },
      {
        get(target, key, receiver) {
          propertyReads += 1;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    expect(() => groupToolUsesForExecution(
      [proxiedToolUse],
      permissionView([ORCH_RUN_STATUS]),
    )).toThrow(/Proxy values are not allowed/);
    expect(propertyReads).toBe(0);
  });

  it.each([
    ['undefined', { value: undefined }],
    ['function', { value: () => undefined }],
    ['bigint', { value: 1n }],
    ['non-finite number', { value: Number.NaN }],
    ['class instance', { value: new Date(0) }],
    ['sparse array', { value: new Array(1) }],
  ])('rejects non-JSON input: %s', (_label, input) => {
    expect(() => groupToolUsesForExecution(
      [{ type: 'tool_use', id: 'tu_status', name: ORCH_RUN_STATUS, input }],
      permissionView([ORCH_RUN_STATUS]),
    )).toThrow(/Tool-use snapshot rejected/);
  });

  it('rejects cyclic input', () => {
    const input: Record<string, unknown> = {};
    input['self'] = input;
    expect(() => groupToolUsesForExecution(
      [{ type: 'tool_use', id: 'tu_status', name: ORCH_RUN_STATUS, input }],
      permissionView([ORCH_RUN_STATUS]),
    )).toThrow(/cyclic values are not valid JSON/);
  });
});
