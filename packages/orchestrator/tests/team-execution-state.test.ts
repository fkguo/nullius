import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  applyTeamIntervention,
  buildTeamControlPlaneView,
  createTeamExecutionState,
  markTimedOutAssignments,
  recordHeartbeat,
  recordTeamCheckpoint,
  registerDelegateAssignment,
  restoreTeamCheckpoint,
  TeamExecutionStateManager,
  type TeamPermissionMatrix,
} from '../src/index.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'team-execution-state-'));
}

const PERMISSIONS: TeamPermissionMatrix = {
  delegation: [
    {
      from_role: 'lead',
      to_role: 'delegate',
      allowed_task_kinds: ['compute', 'review'],
      allowed_handoff_kinds: ['compute', 'review'],
    },
  ],
  interventions: [
    {
      actor_role: 'lead',
      allowed_scopes: ['task', 'team'],
      allowed_kinds: ['pause', 'resume', 'cancel', 'cascade_stop'],
    },
    {
      actor_role: 'lead',
      allowed_scopes: ['task'],
      allowed_kinds: ['approve', 'redirect', 'inject_task'],
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('team execution state', () => {
  it('fails closed on permission-matrix violations', () => {
    expect(() => createTeamExecutionState({
      workspace_id: 'ws-1',
      coordination_policy: 'supervised_delegate',
      assignment: {
        owner_role: 'lead',
        delegate_role: 'writer',
        delegate_id: 'writer-1',
        task_id: 'task-1',
        task_kind: 'compute',
        handoff_kind: 'compute',
      },
      permissions: PERMISSIONS,
    }, 'run-1')).toThrow(/delegation denied/i);
  });

  it('records checkpoint bindings and restores assignments into needs_recovery', () => {
    const state = createTeamExecutionState({
      workspace_id: 'ws-2',
      coordination_policy: 'supervised_delegate',
      assignment: {
        owner_role: 'lead',
        delegate_role: 'delegate',
        delegate_id: 'delegate-1',
        task_id: 'task-2',
        task_kind: 'compute',
        handoff_id: 'handoff-2',
        handoff_kind: 'compute',
      },
      permissions: PERMISSIONS,
    }, 'run-2');
    const assignment = state.delegate_assignments[0]!;

    const checkpoint = recordTeamCheckpoint(state, {
      assignment_id: assignment.assignment_id,
      checkpoint_id: 'cp-1',
      task_id: assignment.task_id,
      last_completed_step: 'step-7',
      resume_from: 'step-7',
    });
    expect(checkpoint.last_completed_step).toBe('step-7');
    expect(state.delegate_assignments[0]?.resume_from).toBe('step-7');

    const restored = restoreTeamCheckpoint(state, 'cp-1');
    expect(restored.checkpoint_id).toBe('cp-1');
    expect(state.delegate_assignments[0]?.status).toBe('needs_recovery');
    expect(state.active_assignment_ids).toContain(assignment.assignment_id);
  });

  it('records cancel and cascade_stop as structured team interventions', () => {
    const state = createTeamExecutionState({
      workspace_id: 'ws-3',
      coordination_policy: 'parallel',
      assignment: {
        owner_role: 'lead',
        delegate_role: 'delegate',
        delegate_id: 'delegate-1',
        task_id: 'task-3',
        task_kind: 'compute',
        handoff_kind: 'compute',
      },
      permissions: PERMISSIONS,
    }, 'run-3');
    const assignment = state.delegate_assignments[0]!;

    const cancelRecord = applyTeamIntervention(state, {
      kind: 'cancel',
      scope: 'task',
      actor_role: 'lead',
      actor_id: 'pi',
      target_assignment_id: assignment.assignment_id,
      task_id: assignment.task_id,
      note: 'stop this delegate',
    });
    expect(cancelRecord.kind).toBe('cancel');
    expect(state.delegate_assignments[0]?.status).toBe('cancelled');

    const cascadeState = createTeamExecutionState({
      workspace_id: 'ws-4',
      coordination_policy: 'parallel',
      assignment: {
        owner_role: 'lead',
        delegate_role: 'delegate',
        delegate_id: 'delegate-2',
        task_id: 'task-4',
        task_kind: 'compute',
        handoff_kind: 'compute',
      },
      permissions: PERMISSIONS,
    }, 'run-4');
    const cascadeRecord = applyTeamIntervention(cascadeState, {
      kind: 'cascade_stop',
      scope: 'team',
      actor_role: 'lead',
      actor_id: 'pi',
      note: 'upstream failure',
    });
    expect(cascadeRecord.kind).toBe('cascade_stop');
    expect(cascadeState.delegate_assignments.every(item => item.status === 'cascade_stopped')).toBe(true);
    expect(cascadeState.active_assignment_ids).toEqual([]);
    const view = buildTeamControlPlaneView(cascadeState);
    expect(view.live_status.terminal_assignments[0]?.status).toBe('cascade_stopped');
    expect(view.replay.some(entry => entry.kind === 'intervention_applied')).toBe(true);
  });

  it('applies team-scoped pause to all active assignments and fails closed on unsupported scope/kind before mutating state', () => {
    const state = createTeamExecutionState({
      workspace_id: 'ws-team-scope',
      coordination_policy: 'parallel',
      assignment: {
        owner_role: 'lead',
        delegate_role: 'delegate',
        delegate_id: 'delegate-1',
        task_id: 'task-team-1',
        task_kind: 'compute',
        handoff_kind: 'compute',
      },
      permissions: PERMISSIONS,
    }, 'run-team-scope');
    registerDelegateAssignment(state, {
      owner_role: 'lead',
      delegate_role: 'delegate',
      delegate_id: 'delegate-2',
      task_id: 'task-team-2',
      task_kind: 'review',
      handoff_kind: 'review',
    });

    applyTeamIntervention(state, {
      kind: 'pause',
      scope: 'team',
      actor_role: 'lead',
      actor_id: 'pi',
      note: 'pause whole team',
    });

    expect(state.delegate_assignments.map(item => item.status)).toEqual(['paused', 'paused']);
    const pauseEvents = state.event_log.filter(event =>
      event.kind === 'assignment_status_changed' && event.payload.reason === 'intervention',
    );
    expect(pauseEvents).toHaveLength(2);

    const customPermissions: TeamPermissionMatrix = {
      ...PERMISSIONS,
      interventions: [{ actor_role: 'lead', allowed_scopes: ['task', 'team', 'project'], allowed_kinds: ['redirect'] }],
    };
    const negativeState = createTeamExecutionState({
      workspace_id: 'ws-negative',
      coordination_policy: 'parallel',
      assignment: {
        owner_role: 'lead',
        delegate_role: 'delegate',
        delegate_id: 'delegate-1',
        task_id: 'task-negative',
        task_kind: 'compute',
        handoff_kind: 'compute',
      },
      permissions: customPermissions,
    }, 'run-negative');
    const originalEventCount = negativeState.event_log.length;
    const originalInterventionCount = negativeState.interventions.length;
    const originalStatus = negativeState.delegate_assignments[0]?.status;

    expect(() => applyTeamIntervention(negativeState, {
      kind: 'redirect',
      scope: 'project',
      actor_role: 'lead',
      actor_id: 'pi',
      note: 'not implemented here',
    })).toThrow(/does not implement/);
    expect(negativeState.event_log).toHaveLength(originalEventCount);
    expect(negativeState.interventions).toHaveLength(originalInterventionCount);
    expect(negativeState.delegate_assignments[0]?.status).toBe(originalStatus);
  });

  it('clears persisted approval metadata when a task-scoped approve intervention resumes an awaiting assignment', () => {
    const state = createTeamExecutionState({
      workspace_id: 'ws-approve',
      coordination_policy: 'supervised_delegate',
      assignment: {
        owner_role: 'lead',
        delegate_role: 'delegate',
        delegate_id: 'delegate-1',
        task_id: 'task-approve',
        task_kind: 'compute',
      },
      permissions: PERMISSIONS,
    }, 'run-approve');

    state.delegate_assignments[0]!.status = 'awaiting_approval';
    state.delegate_assignments[0]!.approval_id = 'apr_nested';
    state.delegate_assignments[0]!.approval_packet_path = 'artifacts/runs/run-approve__assignment/approval_packet_v1.json';
    state.delegate_assignments[0]!.approval_requested_at = '2026-03-21T00:00:00Z';

    applyTeamIntervention(state, {
      kind: 'approve',
      scope: 'task',
      actor_role: 'lead',
      actor_id: 'pi',
      task_id: 'task-approve',
    });

    expect(state.delegate_assignments[0]).toMatchObject({
      status: 'pending',
      approval_id: null,
      approval_packet_path: null,
      approval_requested_at: null,
    });
  });

  it('stores task-scoped redirect payloads on the targeted assignment without mutating sibling assignments', () => {
    const state = createTeamExecutionState({
      workspace_id: 'ws-redirect',
      coordination_policy: 'parallel',
      assignment: {
        owner_role: 'lead',
        delegate_role: 'delegate',
        delegate_id: 'delegate-1',
        task_id: 'task-redirect-1',
        task_kind: 'compute',
        handoff_kind: 'compute',
      },
      permissions: PERMISSIONS,
    }, 'run-redirect');
    registerDelegateAssignment(state, {
      owner_role: 'lead',
      delegate_role: 'delegate',
      delegate_id: 'delegate-2',
      task_id: 'task-redirect-2',
      task_kind: 'review',
      handoff_kind: 'review',
    });

    const record = applyTeamIntervention(state, {
      kind: 'redirect',
      scope: 'task',
      actor_role: 'lead',
      actor_id: 'pi',
      task_id: 'task-redirect-1',
      note: 're-check the error budget',
      payload: { focus: 'error-budget', preserve_evidence: true },
    });

    expect(record.kind).toBe('redirect');
    expect(state.delegate_assignments[0]?.pending_redirect).toMatchObject({
      note: 're-check the error budget',
      payload: { focus: 'error-budget', preserve_evidence: true },
      created_at: expect.any(String),
    });
    expect(state.delegate_assignments[1]?.pending_redirect).toBeNull();
  });

  it('registers an injected follow-on assignment through the normal team state path', () => {
    const state = createTeamExecutionState({
      workspace_id: 'ws-inject',
      coordination_policy: 'stage_gated',
      assignment: {
        owner_role: 'lead',
        delegate_role: 'delegate',
        delegate_id: 'delegate-1',
        task_id: 'task-seed',
        task_kind: 'compute',
        handoff_kind: 'compute',
      },
      permissions: PERMISSIONS,
    }, 'run-inject');

    applyTeamIntervention(state, {
      kind: 'inject_task',
      scope: 'task',
      actor_role: 'lead',
      actor_id: 'pi',
      task_id: 'task-seed',
      payload: {
        stage: 1,
        task_id: 'task-followup',
        task_kind: 'review',
        delegate_role: 'delegate',
        delegate_id: 'delegate-2',
        handoff_kind: 'review',
      },
    });

    expect(state.delegate_assignments).toHaveLength(2);
    expect(state.delegate_assignments[1]).toMatchObject({
      stage: 1,
      task_id: 'task-followup',
      task_kind: 'review',
      delegate_role: 'delegate',
      delegate_id: 'delegate-2',
      owner_role: 'lead',
      handoff_kind: 'review',
      status: 'pending',
    });
    expect(state.event_log.filter(event => event.kind === 'assignment_registered')).toHaveLength(2);
  });

  it('restores paused assignments back to their original recoverable statuses on resume', () => {
    const state = createTeamExecutionState({
      workspace_id: 'ws-resume-preserve',
      coordination_policy: 'parallel',
      assignment: {
        owner_role: 'lead',
        delegate_role: 'delegate',
        delegate_id: 'delegate-1',
        task_id: 'task-awaiting',
        task_kind: 'compute',
        handoff_kind: 'compute',
      },
      permissions: PERMISSIONS,
    }, 'run-resume-preserve');
    const recoverable = registerDelegateAssignment(state, {
      owner_role: 'lead',
      delegate_role: 'delegate',
      delegate_id: 'delegate-2',
      task_id: 'task-recover',
      task_kind: 'review',
      handoff_kind: 'review',
    });

    state.delegate_assignments[0]!.status = 'awaiting_approval';
    recoverable.status = 'needs_recovery';

    applyTeamIntervention(state, {
      kind: 'pause',
      scope: 'team',
      actor_role: 'lead',
      actor_id: 'pi',
    });

    expect(state.delegate_assignments.map(item => [item.task_id, item.status, item.paused_from_status])).toEqual([
      ['task-awaiting', 'paused', 'awaiting_approval'],
      ['task-recover', 'paused', 'needs_recovery'],
    ]);

    applyTeamIntervention(state, {
      kind: 'resume',
      scope: 'team',
      actor_role: 'lead',
      actor_id: 'pi',
    });

    expect(state.delegate_assignments.map(item => [item.task_id, item.status, item.paused_from_status])).toEqual([
      ['task-awaiting', 'awaiting_approval', null],
      ['task-recover', 'needs_recovery', null],
    ]);
  });

  it('persists state atomically through the team state manager', () => {
    const projectRoot = makeTmpDir();
    try {
      const manager = new TeamExecutionStateManager(projectRoot);
      const state = createTeamExecutionState({
        workspace_id: 'ws-5',
        coordination_policy: 'supervised_delegate',
        assignment: {
          owner_role: 'lead',
          delegate_role: 'delegate',
          delegate_id: 'delegate-1',
          task_id: 'task-5',
          task_kind: 'compute',
          handoff_kind: 'compute',
        },
        permissions: PERMISSIONS,
      }, 'run-5');
      manager.save(state);
      const loaded = manager.load('run-5');
      expect(loaded?.workspace_id).toBe('ws-5');
      expect(fs.existsSync(manager.pathFor('run-5'))).toBe(true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('marks active assignments as timed out without touching terminal ones', () => {
    const state = createTeamExecutionState({
      workspace_id: 'ws-6',
      coordination_policy: 'parallel',
      assignment: {
        owner_role: 'lead',
        delegate_role: 'delegate',
        delegate_id: 'delegate-1',
        task_id: 'task-6',
        task_kind: 'compute',
        handoff_kind: 'compute',
        timeout_at: '2026-03-19T00:00:00Z',
      },
      permissions: PERMISSIONS,
    }, 'run-6');
    const assignmentId = state.delegate_assignments[0]!.assignment_id;
    recordHeartbeat(state, assignmentId, '2026-03-19T12:00:00Z');

    const timedOut = markTimedOutAssignments(state, '2026-03-20T00:00:00Z');
    expect(timedOut).toHaveLength(1);
    expect(state.delegate_assignments[0]?.status).toBe('timed_out');
    const view = buildTeamControlPlaneView(state);
    expect(view.live_status.terminal_assignments[0]?.timeout_at).toBe('2026-03-19T00:00:00Z');
    expect(view.live_status.terminal_assignments[0]?.last_heartbeat_at).toBe('2026-03-19T12:00:00Z');
  });
});
