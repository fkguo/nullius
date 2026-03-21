import { randomUUID } from 'node:crypto';
import { appendTeamEvent } from './team-execution-events.js';
import { findMatchingAssignment } from './team-execution-assignment-builder.js';
import {
  applyTeamIntervention,
  createTeamExecutionState,
  registerDelegateAssignment,
} from './team-execution-state.js';
import { TeamExecutionStateManager } from './team-execution-storage.js';
import { buildTeamControlPlaneView } from './team-execution-view.js';
import {
  buildRuntimeBuckets,
  buildRuntimeProtocol,
  executeRuntimeBucket,
} from './team-unified-runtime-support.js';
import {
  assertSequentialPolicyBoundary,
  executeSequentialRuntime,
} from './team-unified-runtime-sequential.js';
import type { TeamExecutionState } from './team-execution-types.js';
import type {
  ExecuteUnifiedTeamRuntimeInput,
  ExecuteUnifiedTeamRuntimeResult,
  TeamAssignmentExecutionResult,
  TeamRuntimeAssignmentInput,
} from './team-unified-runtime-types.js';

export type {
  ExecuteUnifiedTeamRuntimeInput,
  ExecuteUnifiedTeamRuntimeResult,
  TeamAssignmentExecutionResult,
  TeamRuntimeAssignmentInput,
} from './team-unified-runtime-types.js';

function ensureAssignmentRegistration(
  state: TeamExecutionState,
  input: ExecuteUnifiedTeamRuntimeInput,
  assignment: TeamRuntimeAssignmentInput & { assignment_id: string },
): TeamExecutionState['delegate_assignments'][number] {
  const existing = findMatchingAssignment(state.delegate_assignments, assignment);
  if (existing) return existing;
  return registerDelegateAssignment(state, {
    ...assignment,
    delegation_protocol: buildRuntimeProtocol(input, assignment, assignment.assignment_id),
  });
}

export async function executeUnifiedTeamRuntime(
  input: ExecuteUnifiedTeamRuntimeInput,
): Promise<ExecuteUnifiedTeamRuntimeResult> {
  const manager = new TeamExecutionStateManager(input.projectRoot);
  const preparedAssignments = input.assignments.map(assignment => ({
    ...assignment,
    assignment_id: assignment.assignment_id ?? randomUUID(),
  }));
  const [headAssignment] = preparedAssignments;
  if (!headAssignment) throw new Error('team runtime requires at least one assignment');
  const state = manager.load(input.runId) ?? createTeamExecutionState({
    workspace_id: input.workspaceId,
    coordination_policy: input.coordinationPolicy,
    assignment: {
      ...headAssignment,
      delegation_protocol: buildRuntimeProtocol(input, headAssignment, headAssignment.assignment_id),
    },
    permissions: input.permissions,
  }, input.runId);
  for (const assignment of state.delegate_assignments) {
    assignment.approval_id ??= null;
    assignment.approval_packet_path ??= null;
    assignment.approval_requested_at ??= null;
    assignment.pending_redirect ??= null;
  }
  state.blocked_stage ??= null;
  state.event_log ??= [];
  preparedAssignments.forEach(assignment =>
    ensureAssignmentRegistration(state, input, assignment),
  );
  for (const command of input.interventions ?? []) applyTeamIntervention(state, command);
  manager.save(state);

  const orderedAssignments = [...state.delegate_assignments].sort((left, right) => left.stage - right.stage);
  const assignmentResults: TeamAssignmentExecutionResult[] = [];
  assertSequentialPolicyBoundary(input.coordinationPolicy, orderedAssignments);

  if (input.coordinationPolicy === 'sequential') {
    assignmentResults.push(...await executeSequentialRuntime(input, state, manager, orderedAssignments));
  } else {
    const buckets = buildRuntimeBuckets(input.coordinationPolicy, orderedAssignments);
    for (const bucket of buckets) {
      if (input.coordinationPolicy === 'stage_gated') {
        appendTeamEvent(state, {
          kind: 'stage_started',
          payload: { stage: bucket.stage, assignment_count: bucket.assignments.length },
        });
        manager.save(state);
      }
      const bucketResults = await executeRuntimeBucket(input, state, manager, bucket);
      assignmentResults.push(...bucketResults);
      if (input.coordinationPolicy !== 'stage_gated') continue;
      if (bucketResults.some(result => result.status !== 'completed')) {
        state.blocked_stage = bucket.stage;
        appendTeamEvent(state, { kind: 'stage_blocked', payload: { stage: bucket.stage } });
        manager.save(state);
        break;
      }
      if (state.blocked_stage === bucket.stage) {
        state.blocked_stage = null;
      }
      appendTeamEvent(state, { kind: 'stage_completed', payload: { stage: bucket.stage } });
      manager.save(state);
    }
  }

  const { live_status, replay } = buildTeamControlPlaneView(state);
  return {
    assignment_results: assignmentResults,
    blocked_stage: state.blocked_stage,
    team_state: state,
    team_state_path: manager.pathFor(input.runId),
    live_status,
    replay,
  };
}
