import { randomUUID } from 'node:crypto';
import { buildTeamDelegationProtocol } from './delegation-protocol.js';
import { activeAssignmentIds } from './team-execution-assignment-state.js';
import { appendTeamEvent } from './team-execution-events.js';
import type {
  TeamDelegateAssignment,
  TeamExecutionAssignmentInput,
  TeamExecutionState,
} from './team-execution-types.js';
import { sortKeysRecursive, utcNowIso } from './util.js';

type TeamStateSeed = Pick<TeamExecutionState, 'workspace_id' | 'coordination_policy'>;

export function findMatchingAssignment(
  assignments: TeamDelegateAssignment[],
  input: TeamExecutionAssignmentInput,
): TeamDelegateAssignment | null {
  const forkedFromAssignmentId = input.forked_from_assignment_id ?? null;
  const forkedFromSessionId = input.forked_from_session_id ?? null;
  const inheritance = input.mcp_tool_inheritance ?? { mode: 'team_permission_matrix' as const };
  const normalizeAdditive = (toolNames: ReadonlyArray<string> | undefined): string[] =>
    [...new Set((toolNames ?? []).map(name => String(name)).filter(name => name.length > 0))].sort();
  const normalizePayload = (payload: Record<string, unknown> | null | undefined): string =>
    JSON.stringify(sortKeysRecursive(payload ?? null));
  const additive = normalizeAdditive(inheritance.additive_tool_names);
  return assignments.find(candidate =>
    normalizeAdditive(candidate.mcp_tool_inheritance.additive_tool_names).join('\n') === additive.join('\n')
    && candidate.task_id === input.task_id
    && candidate.delegate_id === input.delegate_id
    && candidate.stage === (input.stage ?? 0)
    && candidate.task_kind === input.task_kind
    && candidate.owner_role === input.owner_role
    && candidate.delegate_role === input.delegate_role
    && candidate.handoff_id === (input.handoff_id ?? null)
    && candidate.handoff_kind === (input.handoff_kind ?? null)
    && normalizePayload(candidate.handoff_payload) === normalizePayload(input.handoff_payload)
    && candidate.forked_from_assignment_id === forkedFromAssignmentId
    && candidate.forked_from_session_id === forkedFromSessionId
    && candidate.mcp_tool_inheritance.mode === inheritance.mode
    && (candidate.mcp_tool_inheritance.mode !== 'inherit_from_assignment'
      || (inheritance.mode === 'inherit_from_assignment'
        && candidate.mcp_tool_inheritance.inherit_from_assignment_id === inheritance.inherit_from_assignment_id))
  ) ?? null;
}

export function buildTeamDelegateAssignment(
  state: TeamStateSeed,
  input: TeamExecutionAssignmentInput,
  requiredTools: string[] = [],
  timestamp: string = utcNowIso(),
): TeamDelegateAssignment {
  const assignmentId = input.assignment_id ?? randomUUID();
  const inheritance = input.mcp_tool_inheritance ?? { mode: 'team_permission_matrix' as const };
  return {
    assignment_id: assignmentId,
    stage: input.stage ?? 0,
    delegation_protocol: input.delegation_protocol ?? buildTeamDelegationProtocol({
      assignment_id: assignmentId,
      workspace_id: state.workspace_id,
      task_id: input.task_id,
      task_kind: input.task_kind,
      owner_role: input.owner_role,
      delegate_role: input.delegate_role,
      delegate_id: input.delegate_id,
      coordination_policy: state.coordination_policy,
      stage: input.stage ?? 0,
      handoff_id: input.handoff_id ?? null,
      handoff_kind: input.handoff_kind ?? null,
      handoff_payload: input.handoff_payload ?? null,
      checkpoint_id: input.checkpoint_id ?? null,
      required_tools: requiredTools,
    }),
    owner_role: input.owner_role,
    delegate_role: input.delegate_role,
    delegate_id: input.delegate_id,
    task_id: input.task_id,
    task_kind: input.task_kind,
    handoff_id: input.handoff_id ?? null,
    handoff_kind: input.handoff_kind ?? null,
    handoff_payload: input.handoff_payload ?? null,
    checkpoint_id: input.checkpoint_id ?? null,
    status: 'pending',
    timeout_at: input.timeout_at ?? null,
    paused_from_status: null,
    session_id: null,
    forked_from_assignment_id: input.forked_from_assignment_id ?? null,
    forked_from_session_id: input.forked_from_session_id ?? null,
    mcp_tool_inheritance: inheritance.mode === 'inherit_from_assignment'
      ? {
          mode: 'inherit_from_assignment',
          inherit_from_assignment_id: inheritance.inherit_from_assignment_id,
          ...(inheritance.additive_tool_names !== undefined
            ? { additive_tool_names: [...inheritance.additive_tool_names] }
            : {}),
        }
      : {
          mode: 'team_permission_matrix',
          ...(inheritance.additive_tool_names !== undefined
            ? { additive_tool_names: [...inheritance.additive_tool_names] }
            : {}),
        },
    last_heartbeat_at: null,
    last_completed_step: null,
    resume_from: null,
    approval_id: null,
    approval_packet_path: null,
    approval_requested_at: null,
    pending_redirect: null,
    updated_at: timestamp,
  };
}

export function appendRegisteredAssignment(
  state: TeamExecutionState,
  assignment: TeamDelegateAssignment,
): TeamDelegateAssignment {
  state.delegate_assignments.push(assignment);
  state.active_assignment_ids = activeAssignmentIds(state.delegate_assignments);
  state.updated_at = assignment.updated_at;
  appendTeamEvent(state, {
    kind: 'assignment_registered',
    assignment,
    payload: { stage: assignment.stage, status: assignment.status },
  });
  return assignment;
}
