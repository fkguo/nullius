import { describe, expect, it } from 'vitest';
import {
  ORCH_FLEET_STATUS,
  ORCH_POLICY_QUERY,
  ORCH_RUN_APPROVE,
  ORCH_RUN_CREATE,
  ORCH_RUN_LIST,
  ORCH_RUN_STATUS,
} from '@autoresearch/shared';

import type { ToolUseContent } from '../src/backends/chat-backend.js';
import { groupToolUsesForExecution } from '../src/agent-runner-tool-groups.js';
import type { ToolCaller } from '../src/mcp-client.js';
import { resolveToolExecutionPolicy } from '../src/tool-execution-policy.js';

function toolUse(id: string, name: string): ToolUseContent {
  return {
    type: 'tool_use',
    id,
    name,
    input: {},
  };
}

const TOOL_CALLER = {
  getExecutionPolicy: (toolName: string) => resolveToolExecutionPolicy(toolName),
} satisfies Pick<ToolCaller, 'getExecutionPolicy'>;

describe('groupToolUsesForExecution', () => {
  it('returns no groups for an empty tool-use list', () => {
    expect(groupToolUsesForExecution([], TOOL_CALLER)).toEqual([]);
  });

  it('keeps contiguous batch-safe read-only tools in a single group', () => {
    const groups = groupToolUsesForExecution([
      toolUse('tu_status', ORCH_RUN_STATUS),
      toolUse('tu_list', ORCH_RUN_LIST),
      toolUse('tu_policy', ORCH_POLICY_QUERY),
    ], TOOL_CALLER);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.map(grouped => grouped.name)).toEqual([
      ORCH_RUN_STATUS,
      ORCH_RUN_LIST,
      ORCH_POLICY_QUERY,
    ]);
  });

  it('keeps serial-only tools as singleton groups, including unknown tools', () => {
    const groups = groupToolUsesForExecution([
      toolUse('tu_create', ORCH_RUN_CREATE),
      toolUse('tu_unknown', 'unknown_tool'),
      toolUse('tu_approve', ORCH_RUN_APPROVE),
    ], TOOL_CALLER);

    expect(groups.map(group => group.map(grouped => grouped.name))).toEqual([
      [ORCH_RUN_CREATE],
      ['unknown_tool'],
      [ORCH_RUN_APPROVE],
    ]);
  });

  it('flushes the current batch-safe group before a serial-only tool and starts a new batch afterward', () => {
    const groups = groupToolUsesForExecution([
      toolUse('tu_status', ORCH_RUN_STATUS),
      toolUse('tu_list', ORCH_RUN_LIST),
      toolUse('tu_create', ORCH_RUN_CREATE),
      toolUse('tu_policy', ORCH_POLICY_QUERY),
      toolUse('tu_fleet', ORCH_FLEET_STATUS),
    ], TOOL_CALLER);

    expect(groups.map(group => group.map(grouped => grouped.name))).toEqual([
      [ORCH_RUN_STATUS, ORCH_RUN_LIST],
      [ORCH_RUN_CREATE],
      [ORCH_POLICY_QUERY, ORCH_FLEET_STATUS],
    ]);
  });

  it('still returns a singleton group for a single batch-safe tool', () => {
    const groups = groupToolUsesForExecution([
      toolUse('tu_status', ORCH_RUN_STATUS),
    ], TOOL_CALLER);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.map(grouped => grouped.name)).toEqual([ORCH_RUN_STATUS]);
  });
});
