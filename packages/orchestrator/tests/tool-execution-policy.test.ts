import { describe, expect, it } from 'vitest';
import {
  ORCH_POLICY_QUERY,
  ORCH_RUN_APPROVE,
  ORCH_RUN_EXECUTE_MANIFEST,
  ORCH_RUN_EXPORT,
  ORCH_RUN_PLAN_COMPUTATION,
  ORCH_RUN_RECORD_PROPOSAL_DECISION,
  ORCH_RUN_REJECT,
  ORCH_RUN_REQUEST_FINAL_CONCLUSIONS,
  ORCH_RUN_STATUS,
} from '@nullius/shared';

import { ORCH_TOOL_SPECS } from '../src/orch-tools/index.js';
import {
  ORCHESTRATOR_TOOL_EXECUTION_POLICIES,
  resolveToolExecutionPolicy,
} from '../src/tool-execution-policy.js';

describe('orchestrator tool execution policy authority', () => {
  it('has an exact registry entry for every live ORCH_TOOL_SPECS tool and exposes no fallback metadata', () => {
    const liveNames = ORCH_TOOL_SPECS.map(spec => spec.name).sort();
    const policyNames = Object.keys(ORCHESTRATOR_TOOL_EXECUTION_POLICIES).sort();

    expect(policyNames).toEqual(liveNames);
    expect(new Set(liveNames).size).toBe(liveNames.length);
    for (const spec of ORCH_TOOL_SPECS) {
      expect(spec.execution_policy).toEqual(resolveToolExecutionPolicy(spec.name));
      expect(spec.execution_policy.metadata_source).toBe('registry');
    }
  });

  it('keeps mutation, concurrency, and approval behavior as independent axes', () => {
    expect(resolveToolExecutionPolicy(ORCH_RUN_STATUS)).toMatchObject({
      mutation_class: 'read_only',
      concurrency: 'batch_safe',
      approval_behavior: 'none',
    });
    expect(resolveToolExecutionPolicy(ORCH_RUN_EXPORT)).toMatchObject({
      mutation_class: 'read_only',
      concurrency: 'serial_only',
      approval_behavior: 'none',
    });
    expect(resolveToolExecutionPolicy(ORCH_RUN_RECORD_PROPOSAL_DECISION)).toMatchObject({
      metadata_source: 'registry',
      mutation_class: 'stateful',
      concurrency: 'serial_only',
      approval_behavior: 'none',
    });
    expect(resolveToolExecutionPolicy(ORCH_POLICY_QUERY).approval_behavior).toBe('none');
  });

  it.each([
    ORCH_RUN_PLAN_COMPUTATION,
    ORCH_RUN_EXECUTE_MANIFEST,
    ORCH_RUN_REQUEST_FINAL_CONCLUSIONS,
  ])('registers %s as an approval producer without making approval a mutation class', toolName => {
    expect(resolveToolExecutionPolicy(toolName)).toMatchObject({
      mutation_class: 'stateful',
      concurrency: 'serial_only',
      approval_behavior: 'may_request',
    });
  });

  it.each([ORCH_RUN_APPROVE, ORCH_RUN_REJECT])(
    'registers %s as a host-only approval resolver',
    toolName => {
      expect(resolveToolExecutionPolicy(toolName)).toMatchObject({
        mutation_class: 'stateful',
        concurrency: 'serial_only',
        approval_behavior: 'resolves_approval',
      });
    },
  );

  it('keeps unknown tools fail-safe and serial without granting approval semantics', () => {
    expect(resolveToolExecutionPolicy('unknown_external_tool')).toEqual({
      tool_name: 'unknown_external_tool',
      metadata_source: 'safe_fallback',
      mutation_class: 'stateful',
      concurrency: 'serial_only',
      approval_behavior: 'none',
    });
  });
});
