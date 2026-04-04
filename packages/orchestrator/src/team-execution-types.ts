import type { TeamDelegationProtocol } from './delegation-protocol.js';
import type { ResearchHandoff } from './research-loop/handoff-types.js';
import type {
  ResearchTaskKind,
  ResearchTaskLifecycleProjection,
  ResearchTaskStatus,
} from './research-loop/task-types.js';

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

export type TeamSessionContextKind = 'fresh' | 'resumed' | 'forked' | 'synthetic';

export interface TeamDelegationPermission {
  from_role: string;
  to_role: string;
  allowed_task_kinds: ResearchTaskKind[];
  allowed_handoff_kinds: ResearchHandoff['handoff_kind'][];
  allowed_tool_names?: string[];
}

export type TeamMcpToolInheritance =
  | {
      mode: 'team_permission_matrix';
      additive_tool_names?: string[];
    }
  | {
      mode: 'inherit_from_assignment';
      inherit_from_assignment_id: string;
      additive_tool_names?: string[];
    };

export interface TeamInterventionPermission {
  actor_role: string;
  allowed_scopes: TeamInterventionScope[];
  allowed_kinds: TeamInterventionKind[];
}

export interface TeamPendingRedirect {
  note: string | null;
  payload: Record<string, unknown>;
  created_at: string;
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
  forked_from_assignment_id?: string | null;
  forked_from_session_id?: string | null;
  mcp_tool_inheritance?: TeamMcpToolInheritance;
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
  session_id: string | null;
  forked_from_assignment_id: string | null;
  forked_from_session_id: string | null;
  mcp_tool_inheritance: TeamMcpToolInheritance;
  last_heartbeat_at: string | null;
  last_completed_step: string | null;
  resume_from: string | null;
  approval_id: string | null;
  approval_packet_path: string | null;
  approval_requested_at: string | null;
  pending_redirect: TeamPendingRedirect | null;
  updated_at: string;
}

export interface TeamPendingApproval {
  approval_id: string;
  agent_id: string;
  assignment_id: string;
  session_id: string | null;
  runtime_run_id: string;
  packet_path: string;
  requested_at: string;
}

export interface TeamAssignmentSession {
  session_id: string;
  parent_session_id: string | null;
  context_kind: TeamSessionContextKind;
  agent_id: string;
  assignment_id: string;
  runtime_run_id: string;
  runtime_status: TeamAssignmentStatus;
  task_lifecycle_status: ResearchTaskLifecycleProjection;
  task_status: ResearchTaskStatus;
  started_at: string;
  ended_at: string | null;
  checkpoint_id: string | null;
  last_completed_step: string | null;
  resume_from: string | null;
  forked_from_assignment_id: string | null;
  forked_from_session_id: string | null;
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
  pending_approvals: TeamPendingApproval[];
  sessions: TeamAssignmentSession[];
  active_assignment_ids: string[];
  checkpoints: TeamCheckpointBinding[];
  interventions: TeamInterventionRecord[];
  blocked_stage: number | null;
  event_log: TeamExecutionEvent[];
  updated_at: string;
}
