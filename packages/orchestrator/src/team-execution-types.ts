import type { TeamDelegationProtocol } from './delegation-protocol.js';
import type { ResearchHandoff } from './research-loop/handoff-types.js';
import type { ResearchTaskKind } from './research-loop/task-types.js';

export type TeamCoordinationPolicy = 'sequential' | 'parallel' | 'stage_gated' | 'supervised_delegate';
export type TeamInterventionScope = 'task' | 'team' | 'project';
export type TeamInterventionKind = 'pause' | 'resume' | 'redirect' | 'inject_task' | 'approve' | 'cancel' | 'cascade_stop';
export type TeamAssignmentStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'awaiting_approval'
  | 'needs_recovery'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'cascade_stopped';

export interface TeamDelegationPermission {
  from_role: string;
  to_role: string;
  allowed_task_kinds: ResearchTaskKind[];
  allowed_handoff_kinds: ResearchHandoff['handoff_kind'][];
}

export interface TeamInterventionPermission {
  actor_role: string;
  allowed_scopes: TeamInterventionScope[];
  allowed_kinds: TeamInterventionKind[];
}

export interface TeamPermissionMatrix {
  delegation: TeamDelegationPermission[];
  interventions: TeamInterventionPermission[];
}

export interface TeamExecutionAssignmentInput {
  assignment_id?: string;
  stage?: number;
  delegation_protocol?: TeamDelegationProtocol;
  owner_role: string;
  delegate_role: string;
  delegate_id: string;
  task_id: string;
  task_kind: ResearchTaskKind;
  handoff_id?: string | null;
  handoff_kind?: ResearchHandoff['handoff_kind'] | null;
  checkpoint_id?: string | null;
  timeout_at?: string | null;
}

export interface TeamInterventionCommand {
  kind: TeamInterventionKind;
  scope: TeamInterventionScope;
  actor_role: string;
  actor_id?: string | null;
  target_assignment_id?: string | null;
  task_id?: string | null;
  checkpoint_id?: string | null;
  note?: string;
  payload?: Record<string, unknown>;
}

export interface TeamExecutionInput {
  workspace_id: string;
  coordination_policy: TeamCoordinationPolicy;
  assignment: TeamExecutionAssignmentInput;
  permissions: TeamPermissionMatrix;
  interventions?: TeamInterventionCommand[];
}

export interface TeamDelegateAssignment {
  assignment_id: string;
  stage: number;
  delegation_protocol: TeamDelegationProtocol;
  owner_role: string;
  delegate_role: string;
  delegate_id: string;
  task_id: string;
  task_kind: ResearchTaskKind;
  handoff_id: string | null;
  handoff_kind: ResearchHandoff['handoff_kind'] | null;
  checkpoint_id: string | null;
  status: TeamAssignmentStatus;
  timeout_at: string | null;
  paused_from_status: TeamAssignmentStatus | null;
  last_heartbeat_at: string | null;
  last_completed_step: string | null;
  resume_from: string | null;
  updated_at: string;
}

export interface TeamCheckpointBinding {
  checkpoint_id: string;
  assignment_id: string;
  task_id: string;
  handoff_id: string | null;
  last_completed_step: string | null;
  resume_from: string | null;
  updated_at: string;
}

export interface TeamInterventionRecord {
  intervention_id: string;
  kind: TeamInterventionKind;
  scope: TeamInterventionScope;
  actor_role: string;
  actor_id: string | null;
  target_assignment_id: string | null;
  task_id: string | null;
  checkpoint_id: string | null;
  note: string | null;
  created_at: string;
  payload: Record<string, unknown>;
}

export type TeamExecutionEventKind =
  | 'assignment_registered'
  | 'assignment_started'
  | 'assignment_status_changed'
  | 'checkpoint_recorded'
  | 'checkpoint_restored'
  | 'intervention_applied'
  | 'assignment_timed_out'
  | 'stage_started'
  | 'stage_completed'
  | 'stage_blocked';

export interface TeamExecutionEvent {
  event_id: string;
  kind: TeamExecutionEventKind;
  created_at: string;
  assignment_id: string | null;
  task_id: string | null;
  checkpoint_id: string | null;
  payload: Record<string, unknown>;
}

export interface TeamExecutionState {
  schema_version: 1;
  run_id: string;
  workspace_id: string;
  coordination_policy: TeamCoordinationPolicy;
  permissions: TeamPermissionMatrix;
  delegate_assignments: TeamDelegateAssignment[];
  active_assignment_ids: string[];
  checkpoints: TeamCheckpointBinding[];
  interventions: TeamInterventionRecord[];
  blocked_stage: number | null;
  event_log: TeamExecutionEvent[];
  updated_at: string;
}
