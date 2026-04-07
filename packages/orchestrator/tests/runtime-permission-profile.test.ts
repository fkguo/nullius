import { describe, expect, it } from 'vitest';

import {
  buildDirectRuntimePermissionProfile,
  type RuntimePermissionProfileV1,
} from '../src/runtime-permission-profile.js';
import { compileDelegatedRuntimePermissionProfile } from '../src/team-execution-permissions.js';
import type { TeamPermissionMatrix } from '../src/team-execution-types.js';
import {
  buildRuntimeToolPermissionView,
  filterToolsForPermissionView,
} from '../src/tool-execution-policy.js';

const TOOLS = [
  { name: 'tool_a', input_schema: { type: 'object', properties: {} } },
  { name: 'tool_b', input_schema: { type: 'object', properties: {} } },
  { name: 'tool_c', input_schema: { type: 'object', properties: {} } },
] as const;

describe('RuntimePermissionProfileV1', () => {
  it('compiles the direct runtime path into a typed permission profile and view', () => {
    const profile = buildDirectRuntimePermissionProfile({ tools: TOOLS });
    const view = buildRuntimeToolPermissionView(profile);

    expect(profile).toMatchObject({
      version: 1,
      actor: {
        scope: 'agent_session',
        actor_id: null,
        source: 'host_runtime',
      },
      tools: {
        allowed_tool_names: ['tool_a', 'tool_b', 'tool_c'],
        inheritance_mode: 'runtime_tools',
      },
      sandbox: {
        filesystem: { mode: 'inherit_host' },
        network: { mode: 'inherit_host' },
      },
      approvals: {
        mode: 'inherit_gate',
        grant_scope: 'session',
        reviewer: null,
      },
    });
    expect(view).toMatchObject({
      scope: 'agent_session',
      authority: 'runtime_permission_profile',
      authority_source: 'host_runtime',
      allowed_tool_names: ['tool_a', 'tool_b', 'tool_c'],
    });
    expect(filterToolsForPermissionView(TOOLS, view).map(tool => tool.name)).toEqual(['tool_a', 'tool_b', 'tool_c']);
    expect(Object.keys(view.execution_policies)).toEqual(['tool_a', 'tool_b', 'tool_c']);
  });

  it('keeps delegated inheritance matrix-bounded while carrying assignment approval metadata', () => {
    const permissions: TeamPermissionMatrix = {
      delegation: [
        {
          from_role: 'lead',
          to_role: 'delegate',
          allowed_task_kinds: ['compute'],
          allowed_handoff_kinds: ['compute'],
          allowed_tool_names: ['tool_a'],
        },
        {
          from_role: 'lead',
          to_role: 'delegate_plus',
          allowed_task_kinds: ['compute'],
          allowed_handoff_kinds: ['compute'],
          allowed_tool_names: ['tool_a', 'tool_b'],
        },
      ],
      interventions: [],
    };

    const state = {
      delegate_assignments: [
        {
          assignment_id: 'assignment-parent',
          owner_role: 'lead',
          delegate_role: 'delegate',
          delegate_id: 'delegate-1',
          task_id: 'task-parent',
          task_kind: 'compute',
        },
      ],
    };

    const profile = compileDelegatedRuntimePermissionProfile(
      permissions,
      {
        assignment_id: 'assignment-child',
        owner_role: 'lead',
        delegate_role: 'delegate_plus',
        delegate_id: 'delegate-2',
        task_id: 'task-child',
        task_kind: 'compute',
        mcp_tool_inheritance: {
          mode: 'inherit_from_assignment',
          inherit_from_assignment_id: 'assignment-parent',
          additive_tool_names: ['tool_b'],
        },
        approval_id: 'apr_child',
        approval_packet_path: 'artifacts/runs/run__child/approval_packet_v1.json',
        approval_requested_at: '2026-04-07T00:00:00Z',
      },
      TOOLS,
      state,
    );
    const view = buildRuntimeToolPermissionView(profile);

    expect(profile).toMatchObject({
      actor: {
        scope: 'delegated_assignment',
        actor_id: 'delegate-2',
        source: 'team_permission_matrix',
      },
      tools: {
        allowed_tool_names: ['tool_a', 'tool_b'],
        inheritance_mode: 'inherit_from_assignment',
        inherit_from_assignment_id: 'assignment-parent',
      },
      approvals: {
        mode: 'inherit_gate',
        grant_scope: 'assignment',
        reviewer: 'lead',
        assignment_approval_id: 'apr_child',
        assignment_approval_packet_path: 'artifacts/runs/run__child/approval_packet_v1.json',
        assignment_approval_requested_at: '2026-04-07T00:00:00Z',
      },
    } satisfies Partial<RuntimePermissionProfileV1>);
    expect(view).toMatchObject({
      authority: 'runtime_permission_profile',
      authority_source: 'team_permission_matrix',
      allowed_tool_names: ['tool_a', 'tool_b'],
    });
    expect(filterToolsForPermissionView(TOOLS, view).map(tool => tool.name)).toEqual(['tool_a', 'tool_b']);
    expect(Object.keys(view.execution_policies)).toEqual(['tool_a', 'tool_b']);
    expect(Object.values(view.execution_policies).map(policy => policy.metadata_source)).toEqual(['safe_fallback', 'safe_fallback']);
  });
});
