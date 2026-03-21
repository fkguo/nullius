import type { MessageParam, Tool } from './backends/chat-backend.js';
import type { ExecuteDelegatedAgentRuntimeInput } from './research-loop/delegated-agent-runtime.js';
import type { ExecuteTeamDelegatedRuntimeResult } from './team-execution-runtime-types.js';
import type {
  TeamAssignmentStatus,
  TeamCoordinationPolicy,
  TeamExecutionAssignmentInput,
  TeamExecutionState,
  TeamInterventionCommand,
  TeamPermissionMatrix,
} from './team-execution-types.js';
import type { TeamDelegationProtocol } from './delegation-protocol.js';
import type { TeamLiveStatusView, TeamReplayEntry } from './team-execution-view.js';

export interface TeamRuntimeAssignmentInput extends TeamExecutionAssignmentInput {}

export interface ExecuteUnifiedTeamRuntimeInput
  extends Pick<ExecuteDelegatedAgentRuntimeInput, 'approvalGate' | 'backendFactory' | 'maxTurns' | 'mcpClient' | 'model' | 'projectRoot' | 'routingConfig' | 'runId' | 'spanCollector' | '_messagesCreate'> {
  workspaceId: string;
  coordinationPolicy: TeamCoordinationPolicy;
  permissions: TeamPermissionMatrix;
  assignments: TeamRuntimeAssignmentInput[];
  messages: MessageParam[];
  tools: Tool[];
  interventions?: TeamInterventionCommand[];
  resumeFrom?: string;
}

export interface TeamAssignmentExecutionResult extends ExecuteTeamDelegatedRuntimeResult {
  task_id: string;
  stage: number;
  status: TeamAssignmentStatus;
  delegation_protocol: TeamDelegationProtocol;
  runtime_run_id: string;
}

export interface ExecuteUnifiedTeamRuntimeResult {
  assignment_results: TeamAssignmentExecutionResult[];
  blocked_stage: number | null;
  team_state: TeamExecutionState;
  team_state_path: string;
  live_status: TeamLiveStatusView;
  replay: TeamReplayEntry[];
}
